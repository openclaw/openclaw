import { isSingleUseReplyToMode } from "../../auto-reply/reply/reply-reference.js";
export function createReplyToFanout(params) {
    const replyToId = params.replyToId ?? undefined;
    if (!replyToId) {
        return () => undefined;
    }
    const singleUse = params.replyToIdSource !== "explicit" &&
        params.replyToMode !== undefined &&
        isSingleUseReplyToMode(params.replyToMode);
    if (!singleUse) {
        return () => replyToId;
    }
    let current = replyToId;
    return () => {
        const value = current;
        current = undefined;
        return value;
    };
}
export function createReplyToDeliveryPolicy(params) {
    const singleUseReplyTo = params.replyToMode ? isSingleUseReplyToMode(params.replyToMode) : false;
    let replyToConsumed = false;
    const resolveCurrentReplyTo = (payload) => {
        if (payload.replyToId != null) {
            return payload.replyToId ? { replyToId: payload.replyToId, source: "explicit" } : {};
        }
        const replyToId = (params.replyToMode === "off" ? undefined : params.replyToId) ?? undefined;
        if (!replyToId) {
            return {};
        }
        if (!singleUseReplyTo) {
            return { replyToId, source: "implicit" };
        }
        return replyToConsumed ? {} : { replyToId, source: "implicit" };
    };
    const applyReplyToConsumption = (overrides, options) => {
        if (!options?.consumeImplicitReply || !overrides.replyToId || !singleUseReplyTo) {
            return overrides;
        }
        if (replyToConsumed) {
            return { ...overrides, replyToId: undefined };
        }
        replyToConsumed = true;
        return overrides;
    };
    return { resolveCurrentReplyTo, applyReplyToConsumption };
}
