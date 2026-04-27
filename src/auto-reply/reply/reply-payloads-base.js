import { hasReplyPayloadContent } from "../../interactive/payload.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { extractReplyToTag } from "./reply-tags.js";
import { createReplyToModeFilterForChannel, resolveImplicitCurrentMessageReplyAllowance, } from "./reply-threading.js";
export function formatBtwTextForExternalDelivery(payload) {
    const text = normalizeOptionalString(payload.text);
    if (!text) {
        return payload.text;
    }
    const question = normalizeOptionalString(payload.btw?.question);
    if (!question) {
        return payload.text;
    }
    const formatted = `BTW\nQuestion: ${question}\n\n${text}`;
    return text === formatted || text.startsWith("BTW\nQuestion:") ? text : formatted;
}
function resolveReplyThreadingForPayload(params) {
    const implicitReplyToId = normalizeOptionalString(params.implicitReplyToId);
    const currentMessageId = normalizeOptionalString(params.currentMessageId);
    const allowImplicitReplyToCurrentMessage = resolveImplicitCurrentMessageReplyAllowance(params.replyToMode, params.replyThreading);
    let resolved = params.payload.replyToId ||
        params.payload.replyToCurrent === false ||
        !implicitReplyToId ||
        !allowImplicitReplyToCurrentMessage
        ? params.payload
        : { ...params.payload, replyToId: implicitReplyToId };
    if (typeof resolved.text === "string" && resolved.text.includes("[[")) {
        const { cleaned, replyToId, replyToCurrent, hasTag } = extractReplyToTag(resolved.text, currentMessageId);
        resolved = {
            ...resolved,
            text: cleaned ? cleaned : undefined,
            replyToId: replyToId ?? resolved.replyToId,
            replyToTag: hasTag || resolved.replyToTag,
            replyToCurrent: replyToCurrent || resolved.replyToCurrent,
        };
    }
    if (resolved.replyToCurrent && !resolved.replyToId && currentMessageId) {
        resolved = {
            ...resolved,
            replyToId: currentMessageId,
        };
    }
    return resolved;
}
export function applyReplyTagsToPayload(payload, currentMessageId) {
    return resolveReplyThreadingForPayload({ payload, currentMessageId });
}
export function isRenderablePayload(payload) {
    return hasReplyPayloadContent(payload, { extraContent: payload.audioAsVoice });
}
export function shouldSuppressReasoningPayload(payload) {
    return payload.isReasoning === true;
}
export function applyReplyThreading(params) {
    const { payloads, replyToMode, replyToChannel, currentMessageId, replyThreading } = params;
    const applyReplyToMode = createReplyToModeFilterForChannel(replyToMode, replyToChannel);
    const implicitReplyToId = normalizeOptionalString(currentMessageId);
    return payloads
        .map((payload) => resolveReplyThreadingForPayload({
        payload,
        replyToMode,
        implicitReplyToId,
        currentMessageId,
        replyThreading,
    }))
        .filter(isRenderablePayload)
        .map(applyReplyToMode);
}
