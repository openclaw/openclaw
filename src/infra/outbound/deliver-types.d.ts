import type { ChannelId } from "../../channels/plugins/channel-id.types.js";
export type OutboundDeliveryResult = {
    channel: Exclude<ChannelId, "none">;
    messageId: string;
    chatId?: string;
    channelId?: string;
    roomId?: string;
    conversationId?: string;
    timestamp?: number;
    toJid?: string;
    pollId?: string;
    meta?: Record<string, unknown>;
};
