import type { OutboundDeliveryResult } from "./deliver.js";
export type OutboundDeliveryJson = {
    channel: string;
    via: "direct" | "gateway";
    to: string;
    messageId: string;
    mediaUrl: string | null;
    chatId?: string;
    channelId?: string;
    roomId?: string;
    conversationId?: string;
    timestamp?: number;
    toJid?: string;
    meta?: Record<string, unknown>;
};
type OutboundDeliveryMeta = {
    messageId?: string;
    chatId?: string;
    channelId?: string;
    roomId?: string;
    conversationId?: string;
    timestamp?: number;
    toJid?: string;
    meta?: Record<string, unknown>;
};
export declare function formatOutboundDeliverySummary(channel: string, result?: OutboundDeliveryResult): string;
export declare function buildOutboundDeliveryJson(params: {
    channel: string;
    to: string;
    result?: OutboundDeliveryMeta | OutboundDeliveryResult;
    via?: "direct" | "gateway";
    mediaUrl?: string | null;
}): OutboundDeliveryJson;
export declare function formatGatewaySummary(params: {
    action?: string;
    channel?: string;
    messageId?: string | null;
}): string;
export {};
