import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import { isRenderablePayload, shouldSuppressReasoningPayload, } from "../../auto-reply/reply/reply-payloads.js";
function mergeMediaUrls(...lists) {
    const seen = new Set();
    const merged = [];
    for (const list of lists) {
        if (!list) {
            continue;
        }
        for (const entry of list) {
            const trimmed = entry?.trim();
            if (!trimmed) {
                continue;
            }
            if (seen.has(trimmed)) {
                continue;
            }
            seen.add(trimmed);
            merged.push(trimmed);
        }
    }
    return merged;
}
export function normalizeReplyPayloadsForDelivery(payloads) {
    return payloads.flatMap((payload) => {
        if (shouldSuppressReasoningPayload(payload)) {
            return [];
        }
        const parsed = parseReplyDirectives(payload.text ?? "");
        const explicitMediaUrls = payload.mediaUrls ?? parsed.mediaUrls;
        const explicitMediaUrl = payload.mediaUrl ?? parsed.mediaUrl;
        const mergedMedia = mergeMediaUrls(explicitMediaUrls, explicitMediaUrl ? [explicitMediaUrl] : undefined);
        const hasMultipleMedia = (explicitMediaUrls?.length ?? 0) > 1;
        const resolvedMediaUrl = hasMultipleMedia ? undefined : explicitMediaUrl;
        const next = {
            ...payload,
            text: parsed.text ?? "",
            mediaUrls: mergedMedia.length ? mergedMedia : undefined,
            mediaUrl: resolvedMediaUrl,
            replyToId: payload.replyToId ?? parsed.replyToId,
            replyToTag: payload.replyToTag || parsed.replyToTag,
            replyToCurrent: payload.replyToCurrent || parsed.replyToCurrent,
            audioAsVoice: Boolean(payload.audioAsVoice || parsed.audioAsVoice),
        };
        if (parsed.isSilent && mergedMedia.length === 0) {
            return [];
        }
        if (!isRenderablePayload(next)) {
            return [];
        }
        return [next];
    });
}
export function normalizeOutboundPayloads(payloads) {
    return normalizeReplyPayloadsForDelivery(payloads)
        .map((payload) => {
        const channelData = payload.channelData;
        const normalized = {
            text: payload.text ?? "",
            mediaUrls: payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []),
        };
        if (channelData && Object.keys(channelData).length > 0) {
            normalized.channelData = channelData;
        }
        return normalized;
    })
        .filter((payload) => payload.text ||
        payload.mediaUrls.length > 0 ||
        Boolean(payload.channelData && Object.keys(payload.channelData).length > 0));
}
export function normalizeOutboundPayloadsForJson(payloads) {
    return normalizeReplyPayloadsForDelivery(payloads).map((payload) => ({
        text: payload.text ?? "",
        mediaUrl: payload.mediaUrl ?? null,
        mediaUrls: payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : undefined),
        channelData: payload.channelData,
    }));
}
export function formatOutboundPayloadLog(payload) {
    const lines = [];
    if (payload.text) {
        lines.push(payload.text.trimEnd());
    }
    for (const url of payload.mediaUrls) {
        lines.push(`MEDIA:${url}`);
    }
    return lines.join("\n");
}
