import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ReplyToMode } from "../../config/types.js";
export type ReplyToOverride = {
    replyToId?: string | null | undefined;
    replyToIdSource?: ReplyToResolution["source"] | undefined;
};
export type ReplyToResolution = {
    replyToId?: string;
    source?: "explicit" | "implicit";
};
export declare function createReplyToFanout(params: {
    replyToId?: string | null;
    replyToMode?: ReplyToMode;
    replyToIdSource?: ReplyToResolution["source"];
}): () => string | undefined;
export declare function createReplyToDeliveryPolicy(params: {
    replyToId?: string | null;
    replyToMode?: ReplyToMode;
}): {
    resolveCurrentReplyTo: (payload: ReplyPayload) => ReplyToResolution;
    applyReplyToConsumption: <T extends ReplyToOverride>(overrides: T, options?: {
        consumeImplicitReply?: boolean;
    }) => T;
};
