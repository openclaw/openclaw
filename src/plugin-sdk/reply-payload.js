import { createReplyToFanout } from "../infra/outbound/reply-policy.js";
import { normalizeLowercaseStringOrEmpty, readStringValue } from "../shared/string-coerce.js";
export { buildMediaPayload } from "../channels/plugins/media-payload.js";
const REASONING_PREFIX = "reasoning:";
function trimLeadingMarkdownQuoteMarkers(text) {
    let candidate = text.trimStart();
    while (candidate.startsWith(">")) {
        candidate = candidate.replace(/^(?:>[ \t]?)+/, "").trimStart();
    }
    return candidate;
}
export function isReasoningReplyPayload(payload) {
    if (payload.isReasoning === true) {
        return true;
    }
    const text = payload.text;
    if (typeof text !== "string") {
        return false;
    }
    const normalized = normalizeLowercaseStringOrEmpty(text.trimStart());
    if (normalized.startsWith(REASONING_PREFIX)) {
        return true;
    }
    return normalizeLowercaseStringOrEmpty(trimLeadingMarkdownQuoteMarkers(text)).startsWith(REASONING_PREFIX);
}
/** Extract the supported outbound reply fields from loose tool or agent payload objects. */
export function normalizeOutboundReplyPayload(payload) {
    const text = readStringValue(payload.text);
    const mediaUrls = Array.isArray(payload.mediaUrls)
        ? payload.mediaUrls.filter((entry) => typeof entry === "string" && entry.length > 0)
        : undefined;
    const mediaUrl = readStringValue(payload.mediaUrl);
    const sensitiveMedia = payload.sensitiveMedia === true ? true : undefined;
    const replyToId = readStringValue(payload.replyToId);
    return {
        text,
        mediaUrls,
        mediaUrl,
        sensitiveMedia,
        replyToId,
    };
}
/** Wrap a deliverer so callers can hand it arbitrary payloads while channels receive normalized data. */
export function createNormalizedOutboundDeliverer(handler) {
    return async (payload) => {
        const normalized = payload && typeof payload === "object"
            ? normalizeOutboundReplyPayload(payload)
            : {};
        await handler(normalized);
    };
}
/** Prefer multi-attachment payloads, then fall back to the legacy single-media field. */
export function resolveOutboundMediaUrls(payload) {
    if (payload.mediaUrls?.length) {
        return payload.mediaUrls;
    }
    if (payload.mediaUrl) {
        return [payload.mediaUrl];
    }
    return [];
}
/** Resolve media URLs from a channel sendPayload context after legacy fallback normalization. */
export function resolvePayloadMediaUrls(payload) {
    return resolveOutboundMediaUrls(payload);
}
/** Count outbound media items after legacy single-media fallback normalization. */
export function countOutboundMedia(payload) {
    return resolveOutboundMediaUrls(payload).length;
}
/** Check whether an outbound payload includes any media after normalization. */
export function hasOutboundMedia(payload) {
    return countOutboundMedia(payload) > 0;
}
/** Check whether an outbound payload includes text, optionally trimming whitespace first. */
export function hasOutboundText(payload, options) {
    const text = options?.trim ? payload.text?.trim() : payload.text;
    return Boolean(text);
}
/** Check whether an outbound payload includes any sendable text or media. */
export function hasOutboundReplyContent(payload, options) {
    return hasOutboundText(payload, { trim: options?.trimText }) || hasOutboundMedia(payload);
}
/** Normalize reply payload text/media into a trimmed, sendable shape for delivery paths. */
export function resolveSendableOutboundReplyParts(payload, options) {
    const text = options?.text ?? payload.text ?? "";
    const trimmedText = text.trim();
    const mediaUrls = resolveOutboundMediaUrls(payload)
        .map((entry) => entry.trim())
        .filter(Boolean);
    const mediaCount = mediaUrls.length;
    const hasText = Boolean(trimmedText);
    const hasMedia = mediaCount > 0;
    return {
        text,
        trimmedText,
        mediaUrls,
        mediaCount,
        hasText,
        hasMedia,
        hasContent: hasText || hasMedia,
    };
}
/** Preserve caller-provided chunking, but fall back to the full text when chunkers return nothing. */
export function resolveTextChunksWithFallback(text, chunks) {
    if (chunks.length > 0) {
        return [...chunks];
    }
    if (!text) {
        return [];
    }
    return [text];
}
/** Send media-first payloads intact, or chunk text-only payloads through the caller's transport hooks. */
export async function sendPayloadWithChunkedTextAndMedia(params) {
    const payload = params.ctx.payload;
    const text = payload.text ?? "";
    const urls = resolveOutboundMediaUrls(payload);
    if (!text && urls.length === 0) {
        return params.emptyResult;
    }
    if (urls.length > 0) {
        let lastResult = await params.sendMedia({
            ...params.ctx,
            text,
            mediaUrl: urls[0],
        });
        for (let i = 1; i < urls.length; i++) {
            lastResult = await params.sendMedia({
                ...params.ctx,
                text: "",
                mediaUrl: urls[i],
            });
        }
        return lastResult;
    }
    const limit = params.textChunkLimit;
    const chunks = limit && params.chunker ? params.chunker(text, limit) : [text];
    let lastResult;
    for (const chunk of chunks) {
        lastResult = await params.sendText({ ...params.ctx, text: chunk });
    }
    return lastResult;
}
export async function sendPayloadMediaSequence(params) {
    let lastResult;
    for (let i = 0; i < params.mediaUrls.length; i += 1) {
        const mediaUrl = params.mediaUrls[i];
        if (!mediaUrl) {
            continue;
        }
        lastResult = await params.send({
            text: i === 0 ? params.text : "",
            mediaUrl,
            index: i,
            isFirst: i === 0,
        });
    }
    return lastResult;
}
export async function sendPayloadMediaSequenceOrFallback(params) {
    if (params.mediaUrls.length === 0) {
        return params.sendNoMedia ? await params.sendNoMedia() : params.fallbackResult;
    }
    return (await sendPayloadMediaSequence(params)) ?? params.fallbackResult;
}
export async function sendPayloadMediaSequenceAndFinalize(params) {
    if (params.mediaUrls.length > 0) {
        await sendPayloadMediaSequence(params);
    }
    return await params.finalize();
}
export async function sendTextMediaPayload(params) {
    const text = params.ctx.payload.text ?? "";
    const urls = resolvePayloadMediaUrls(params.ctx.payload);
    if (!text && urls.length === 0) {
        return { channel: params.channel, messageId: "" };
    }
    const nextReplyToId = createReplyToFanout(params.ctx);
    if (urls.length > 0) {
        const audioAsVoice = params.ctx.payload.audioAsVoice ?? params.ctx.audioAsVoice;
        const lastResult = await sendPayloadMediaSequence({
            text,
            mediaUrls: urls,
            send: async ({ text, mediaUrl }) => await params.adapter.sendMedia({
                ...params.ctx,
                text,
                mediaUrl,
                ...(audioAsVoice === undefined ? {} : { audioAsVoice }),
                replyToId: nextReplyToId(),
            }),
        });
        return lastResult ?? { channel: params.channel, messageId: "" };
    }
    const limit = params.adapter.textChunkLimit;
    const chunks = limit && params.adapter.chunker
        ? params.adapter.chunker(text, limit, { formatting: params.ctx.formatting })
        : [text];
    let lastResult;
    for (const chunk of chunks) {
        lastResult = await params.adapter.sendText({
            ...params.ctx,
            text: chunk,
            replyToId: nextReplyToId(),
        });
    }
    return lastResult;
}
/** Detect numeric-looking target ids for channels that distinguish ids from handles. */
export function isNumericTargetId(raw) {
    const trimmed = raw.trim();
    if (!trimmed) {
        return false;
    }
    return /^\d{3,}$/.test(trimmed);
}
/** Append attachment links to plain text when the channel cannot send media inline. */
export function formatTextWithAttachmentLinks(text, mediaUrls) {
    const trimmedText = text?.trim() ?? "";
    if (!trimmedText && mediaUrls.length === 0) {
        return "";
    }
    const mediaBlock = mediaUrls.length
        ? mediaUrls.map((url) => `Attachment: ${url}`).join("\n")
        : "";
    if (!trimmedText) {
        return mediaBlock;
    }
    if (!mediaBlock) {
        return trimmedText;
    }
    return `${trimmedText}\n\n${mediaBlock}`;
}
/** Send a caption with only the first media item, mirroring caption-limited channel transports. */
export async function sendMediaWithLeadingCaption(params) {
    if (params.mediaUrls.length === 0) {
        return false;
    }
    for (const [index, mediaUrl] of params.mediaUrls.entries()) {
        const isFirst = index === 0;
        const caption = isFirst ? params.caption : undefined;
        try {
            await params.send({ mediaUrl, caption });
        }
        catch (error) {
            if (params.onError) {
                await params.onError({
                    error,
                    mediaUrl,
                    caption,
                    index,
                    isFirst,
                });
                continue;
            }
            throw error;
        }
    }
    return true;
}
export async function deliverTextOrMediaReply(params) {
    const { mediaUrls } = resolveSendableOutboundReplyParts(params.payload, {
        text: params.text,
    });
    const sentMedia = await sendMediaWithLeadingCaption({
        mediaUrls,
        caption: params.text,
        send: params.sendMedia,
        onError: params.onMediaError,
    });
    if (sentMedia) {
        return "media";
    }
    if (!params.text) {
        return "empty";
    }
    const chunks = params.chunkText ? params.chunkText(params.text) : [params.text];
    let sentText = false;
    for (const chunk of chunks) {
        if (!chunk) {
            continue;
        }
        await params.sendText(chunk);
        sentText = true;
    }
    return sentText ? "text" : "empty";
}
export async function deliverFormattedTextWithAttachments(params) {
    const text = formatTextWithAttachmentLinks(params.payload.text, resolveOutboundMediaUrls(params.payload));
    if (!text) {
        return false;
    }
    await params.send({
        text,
        replyToId: params.payload.replyToId,
    });
    return true;
}
