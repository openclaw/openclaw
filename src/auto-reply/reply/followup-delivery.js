import { stripHeartbeatToken } from "../heartbeat.js";
import { resolveOriginAccountId, resolveOriginMessageProvider, resolveOriginMessageTo, } from "./origin-routing.js";
import { applyReplyThreading, filterMessagingToolDuplicates, filterMessagingToolMediaDuplicates, shouldSuppressMessagingToolReplies, } from "./reply-payloads.js";
import { resolveReplyToMode } from "./reply-threading.js";
function hasReplyPayloadMedia(payload) {
    if (typeof payload.mediaUrl === "string" && payload.mediaUrl.trim().length > 0) {
        return true;
    }
    return Array.isArray(payload.mediaUrls) && payload.mediaUrls.some((url) => url.trim().length > 0);
}
export function resolveFollowupDeliveryPayloads(params) {
    const replyToChannel = resolveOriginMessageProvider({
        originatingChannel: params.originatingChannel,
        provider: params.messageProvider,
    });
    const replyToMode = resolveReplyToMode(params.cfg, replyToChannel, params.originatingAccountId, params.originatingChatType);
    const sanitizedPayloads = params.payloads.flatMap((payload) => {
        const text = payload.text;
        if (!text || !text.includes("HEARTBEAT_OK")) {
            return [payload];
        }
        const stripped = stripHeartbeatToken(text, { mode: "message" });
        const hasMedia = hasReplyPayloadMedia(payload);
        if (stripped.shouldSkip && !hasMedia) {
            return [];
        }
        return [{ ...payload, text: stripped.text }];
    });
    const replyTaggedPayloads = applyReplyThreading({
        payloads: sanitizedPayloads,
        replyToMode,
        replyToChannel,
    });
    const dedupedPayloads = filterMessagingToolDuplicates({
        payloads: replyTaggedPayloads,
        sentTexts: params.sentTexts ?? [],
    });
    const mediaFilteredPayloads = filterMessagingToolMediaDuplicates({
        payloads: dedupedPayloads,
        sentMediaUrls: params.sentMediaUrls ?? [],
    });
    const suppressMessagingToolReplies = shouldSuppressMessagingToolReplies({
        messageProvider: replyToChannel,
        messagingToolSentTargets: params.sentTargets,
        originatingTo: resolveOriginMessageTo({
            originatingTo: params.originatingTo,
        }),
        accountId: resolveOriginAccountId({
            originatingAccountId: params.originatingAccountId,
        }),
    });
    return suppressMessagingToolReplies ? [] : mediaFilteredPayloads;
}
