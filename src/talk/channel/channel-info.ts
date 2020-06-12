/*
 * Created on Sat May 02 2020
 *
 * Copyright (c) storycraft. Licensed under the MIT Licence.
 */

import { ChatUser, UserInfo } from "../user/chat-user";
import { ChannelInfoStruct } from "../struct/channel-info-struct";
import { Long } from "bson";
import { MemberStruct } from "../struct/member-struct";
import { ChatChannel, OpenChatChannel } from "./chat-channel";
import { OpenLinkStruct } from "../struct/open/open-link-struct";
import { PacketChatOnRoomRes } from "../../packet/packet-chat-on-room";
import { OpenMemberType, OpenLinkType, OpenProfileType } from "../open/open-link-type";
import { ChannelMetaStruct, ChannelMetaType, ProfileMetaContent } from "../struct/channel-meta-struct";


export class ChannelInfo {

    private channel: ChatChannel;

    private lastInfoUpdated: number;

    private roomImageURL: string;
    private roomFullImageURL: string;

    private name: string;

    private isFavorite: boolean;

    private isDirectChan: boolean;

    private channelMetaList: ChannelMetaStruct[];

    private userInfoMap: Map<string, UserInfo>;

    private clientUserInfo: UserInfo;

    private pendingInfoReq: Promise<void> | null;
    private pendingUserInfoReq: Promise<void> | null;

    constructor(channel: ChatChannel) {
        this.channel = channel;

        this.lastInfoUpdated = -1;

        this.userInfoMap = new Map();

        this.roomImageURL = '';
        this.roomFullImageURL = '';

        this.name = '';
        this.isFavorite = false;

        this.channelMetaList = [];
        this.isDirectChan = false;

        this.pendingInfoReq = this.pendingUserInfoReq = null;
        
        this.clientUserInfo = new UserInfo(this.channel.Client.ClientUser);
    }

    get Channel() {
        return this.channel;
    }

    get Name() {
        return this.name;
    }

    get RoomImageURL() {
        return this.roomImageURL;
    }

    get RoomFullImageURL() {
        return this.roomFullImageURL;
    }

    get IsFavorite() {
        return this.isFavorite;
    }

    get RoomType() {
        return this.channel.Type;
    }

    get IsDirectChan() {
        return this.isDirectChan;
    }

    get LastInfoUpdated() {
        return this.lastInfoUpdated;
    }

    get UserIdList(): Long[] {
        return Array.from(this.userInfoMap.keys()).map(strLong => Long.fromString(strLong));
    }

    get ChannelMetaList() {
        return this.channelMetaList;
    }

    hasUserInfo(id: Long) {
        return this.userInfoMap.has(id.toString()) || this.Channel.Client.ClientUser.Id.equals(id);
    }

    get ClientUserInfo(): UserInfo {
        return this.clientUserInfo;
    }

    getUserInfo(user: ChatUser): UserInfo | null {
        return this.getUserInfoId(user.Id);
    }

    getUserInfoId(id: Long): UserInfo | null {
        if (this.clientUserInfo.User.Id.equals(id)) {
            return this.ClientUserInfo;
        }

        if (!this.hasUserInfo(id)) {
            return null;
        }

        return this.userInfoMap.get(id.toString())!;
    }

    async addUserInfo(userId: Long): Promise<void> {
        if (this.hasUserInfo(userId) || this.channel.Client.ClientUser.Id.equals(userId)) {
            throw new Error('This user already joined');
        }

        this.initUserInfo((await this.channel.Client.UserManager.requestSpecificMemberInfo(this.channel.Id, [ userId ]))[0]);
    }

    removeUserInfo(id: Long): boolean {
        if (this.channel.Client.ClientUser.Id.equals(id)) {
            throw new Error('Client user cannot be removed');
        }

        return this.userInfoMap.delete(id.toString());
    }

    updateFromStruct(chatinfoStruct: ChannelInfoStruct) {
        this.isDirectChan = chatinfoStruct.isDirectChat;

        this.channelMetaList = [];
        for (let meta of this.channelMetaList) {
            this.addChannelMeta(meta);
        }

        if (chatinfoStruct.metadata.imageUrl) this.roomImageURL = chatinfoStruct.metadata.imageUrl;
        if (chatinfoStruct.metadata.full_image_url) this.roomFullImageURL = chatinfoStruct.metadata.full_image_url;

        if (chatinfoStruct.metadata.favorite) this.isFavorite = chatinfoStruct.metadata.favorite;

        this.lastInfoUpdated = Date.now();
    }

    updateChannelMeta(changed: ChannelMetaStruct) {
        let len = this.channelMetaList.length;
        for (let i = 0; i < len; i++) {
            let meta = this.channelMetaList[i];
            
            if (meta.type === changed.type) {
                this.channelMetaList.splice(i, 1);
                break;
            }
        }

        this.addChannelMeta(changed);
    }

    protected addChannelMeta(meta: ChannelMetaStruct) {
        this.channelMetaList.push(meta);

        if (meta.type === ChannelMetaType.TITLE) {
            this.updateRoomName(meta.content);
        }

        if (meta.type === ChannelMetaType.PROFILE) {
            try {
                let content = JSON.parse(meta.content) as ProfileMetaContent;
                
                this.roomImageURL = content.imageUrl;
                this.roomFullImageURL = content.fullImageUrl;
            } catch (e) {

            }
        }
    }

    protected updateRoomName(name: string) {
        this.name = name;
    }

    protected initUserInfo(memberStruct: MemberStruct) {
        let info = new UserInfo(this.channel.Client.UserManager.get(memberStruct.userId));
        info.updateFromStruct(memberStruct);

        this.userInfoMap.set(memberStruct.userId.toString(), info);
    }

    async updateInfo(): Promise<void> {
        if (this.pendingInfoReq) return this.pendingInfoReq;

        let resolver: () => void | null;
        this.pendingInfoReq = new Promise((resolve, reject) => resolver = resolve);

        await this.updateMemberInfo();
        await this.updateChannelInfo();

        resolver!();
    }

    protected updateFromChatOnRoom(res: PacketChatOnRoomRes) {
        for (let memberStruct of res.MemberList) {
            if (this.clientUserInfo.User.Id.equals(memberStruct.userId)) {
                this.clientUserInfo.updateFromStruct(memberStruct);
                continue;
            }

            this.initUserInfo(memberStruct);
        }
    }

    protected async updateChannelInfo(): Promise<void> {
        let info = await this.Channel.Client.ChannelManager.requestChannelInfo(this.channel.Id);

        try {
            this.updateFromStruct(info);
        } catch (e) {
            
        }
    }

    protected async updateMemberInfo(): Promise<void> {
        if (this.pendingUserInfoReq) return this.pendingUserInfoReq;

        let resolver: () => void | null;
        this.pendingUserInfoReq = new Promise((resolve, reject) => resolver = resolve);

        this.userInfoMap.clear();

        let res = await this.channel.Client.ChannelManager.requestChatOnRoom(this.channel);

        this.updateFromChatOnRoom(res);

        resolver!();
    }

}

export class OpenChannelInfo extends ChannelInfo {
    
    private linkInfo: OpenLinkStruct = {
        linkId: Long.ZERO,
        openToken: -1,
        linkName: '',
        linkURL: '',
        linkType: OpenLinkType.CHATROOM,
        createdAt: 0,
        owner: {
            userId: Long.ZERO,
            nickname: '',
            profileImageUrl: '',
            originalProfileImageUrl: '',
            fullProfileImageUrl: '',
            memberType: OpenMemberType.UNKNOWN,
            profileType: OpenProfileType.MAIN,
            linkId: Long.ZERO,
            openToken: -1,
            pv: Long.ZERO
        },
        activated: false,
        UNKNOWN2: false,
        maxUser: 0,
        maxChannelLimit: 0,
        canSearchLink: false,
        description: '',
        linkCoverURL: ''
    };

    private memberTypeMap: Map<string, OpenMemberType> = new Map();

    get Channel(): OpenChatChannel {
        return super.Channel as OpenChatChannel;
    }

    get CoverURL() {
        return this.linkInfo.linkCoverURL;
    }

    get LinkURL() {
        return this.linkInfo.linkURL;
    }

    get LinkOwner(): ChatUser {
        return this.Channel.Client.UserManager.get(this.linkInfo.owner.userId);
    }

    canManageChannel(user: ChatUser) {
        return this.canManageChannelId(user.Id);
    }

    canManageChannelId(userId: Long) {
        return this.isManagerId(userId) || userId.equals(this.LinkOwner.Id);
    }

    isManager(user: ChatUser) {
        return this.isManagerId(user.Id);
    }

    isManagerId(userId: Long) {
        return this.getMemberTypeId(userId) === OpenMemberType.MANAGER;
    }

    protected initUserInfo(memberStruct: MemberStruct) {
        super.initUserInfo(memberStruct);

        if (memberStruct.openMemberType) {
            this.updateMemberType(memberStruct.userId, memberStruct.openMemberType);
        }
    }

    updateMemberType(userId: Long, memberType: OpenMemberType) {
        if (!this.hasUserInfo(userId)) return;

        this.memberTypeMap.set(userId.toString(), memberType);
    }

    getMemberType(user: ChatUser): OpenMemberType {
        return this.getMemberTypeId(user.Id);
    }

    getMemberTypeId(userId: Long): OpenMemberType {
        if (!this.hasUserInfo(userId)) OpenMemberType.NONE;

        return this.memberTypeMap.get(userId.toString())!;
    }

    async updateChannelInfo(): Promise<void> {
        await super.updateChannelInfo();

        let openLinkInfo = await this.Channel.Client.OpenChatManager.get(this.Channel.LinkId);

        this.updateRoomName(openLinkInfo.linkName);
        
        this.linkInfo = openLinkInfo;
    }

    protected async updateFromChatOnRoom(res: PacketChatOnRoomRes) {
        super.updateFromChatOnRoom(res);
        
        if (res.ClientOpenProfile) {
            this.ClientUserInfo.updateFromOpenStruct(res.ClientOpenProfile);
            this.updateMemberType(this.ClientUserInfo.User.Id, res.ClientOpenProfile.memberType);
        } else {
            let linkInfo = await this.Channel.Client.OpenChatManager.get(this.Channel.LinkId);

            if (linkInfo.owner.userId.equals(this.ClientUserInfo.User.Id)) this.ClientUserInfo.updateFromOpenStruct(linkInfo.owner);
        }
    }
    
}