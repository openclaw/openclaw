import { type ChunkMode } from "../../auto-reply/chunk.js";
import type { OutboundDeliveryFormattingOptions } from "./formatting.js";
import type { ReplyToOverride } from "./reply-policy.js";
export type OutboundMessageSendOverrides = ReplyToOverride & {
    threadId?: string | number | null;
    audioAsVoice?: boolean;
    forceDocument?: boolean;
};
export type OutboundMessageUnit = {
    kind: "text";
    text: string;
    overrides: OutboundMessageSendOverrides;
} | {
    kind: "media";
    caption?: string;
    mediaUrl: string;
    overrides: OutboundMessageSendOverrides;
};
export type OutboundMessageChunker = (text: string, limit: number, ctx?: {
    formatting?: OutboundDeliveryFormattingOptions;
}) => string[];
type PlanReplyToConsumption = <T extends OutboundMessageSendOverrides>(overrides: T) => T;
export declare function planOutboundTextMessageUnits(params: {
    text: string;
    overrides: OutboundMessageSendOverrides;
    chunker?: OutboundMessageChunker | null;
    chunkerMode?: "text" | "markdown";
    textLimit?: number;
    chunkMode?: ChunkMode;
    formatting?: OutboundDeliveryFormattingOptions;
    consumeReplyTo?: PlanReplyToConsumption;
}): OutboundMessageUnit[];
export declare function planOutboundMediaMessageUnits(params: {
    caption: string;
    mediaUrls: readonly string[];
    overrides: OutboundMessageSendOverrides;
    consumeReplyTo?: PlanReplyToConsumption;
}): OutboundMessageUnit[];
export {};
