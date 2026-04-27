import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { logVerbose } from "../../globals.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import { createBlockReplyCoalescer } from "./block-reply-coalescer.js";
export function createAudioAsVoiceBuffer(params) {
    let seenAudioAsVoice = false;
    return {
        onEnqueue: (payload) => {
            if (payload.audioAsVoice) {
                seenAudioAsVoice = true;
            }
        },
        shouldBuffer: (payload) => params.isAudioPayload(payload),
        finalize: (payload) => (seenAudioAsVoice ? { ...payload, audioAsVoice: true } : payload),
    };
}
export function createBlockReplyPayloadKey(payload) {
    const reply = resolveSendableOutboundReplyParts(payload);
    return JSON.stringify({
        text: reply.trimmedText,
        mediaList: reply.mediaUrls,
        replyToId: payload.replyToId ?? null,
    });
}
export function createBlockReplyContentKey(payload) {
    const reply = resolveSendableOutboundReplyParts(payload);
    // Content-only key used for final-payload suppression after block streaming.
    // This intentionally ignores replyToId so a streamed threaded payload and the
    // later final payload still collapse when they carry the same content.
    return JSON.stringify({ text: reply.trimmedText, mediaList: reply.mediaUrls });
}
const withTimeout = async (promise, timeoutMs, timeoutError) => {
    if (!timeoutMs || timeoutMs <= 0) {
        return promise;
    }
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError), timeoutMs);
    });
    try {
        return await Promise.race([promise, timeoutPromise]);
    }
    finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
};
export function createBlockReplyPipeline(params) {
    const { onBlockReply, timeoutMs, coalescing, buffer } = params;
    const sentKeys = new Set();
    const sentContentKeys = new Set();
    const sentMediaUrls = new Set();
    const pendingKeys = new Set();
    const seenKeys = new Set();
    const bufferedKeys = new Set();
    const bufferedPayloadKeys = new Set();
    const bufferedPayloads = [];
    const streamedTextFragments = [];
    let bufferedAssistantMessageIndex;
    let sendChain = Promise.resolve();
    let aborted = false;
    let didStream = false;
    let didLogTimeout = false;
    const hasSeenOrQueuedPayloadKey = (payloadKey) => seenKeys.has(payloadKey) || sentKeys.has(payloadKey) || pendingKeys.has(payloadKey);
    const flushBufferedAssistantBlock = () => {
        bufferedAssistantMessageIndex = undefined;
        void coalescer?.flush({ force: true });
    };
    const sendPayload = (payload, bypassSeenCheck = false) => {
        if (aborted) {
            return;
        }
        const payloadKey = createBlockReplyPayloadKey(payload);
        const contentKey = createBlockReplyContentKey(payload);
        if (!bypassSeenCheck) {
            if (seenKeys.has(payloadKey)) {
                return;
            }
            seenKeys.add(payloadKey);
        }
        if (sentKeys.has(payloadKey) || pendingKeys.has(payloadKey)) {
            return;
        }
        pendingKeys.add(payloadKey);
        const timeoutError = new Error(`block reply delivery timed out after ${timeoutMs}ms`);
        const abortController = new AbortController();
        sendChain = sendChain
            .then(async () => {
            if (aborted) {
                return false;
            }
            await withTimeout(Promise.resolve(onBlockReply(payload, {
                abortSignal: abortController.signal,
                timeoutMs,
            })), timeoutMs, timeoutError);
            return true;
        })
            .then((didSend) => {
            if (!didSend) {
                return;
            }
            sentKeys.add(payloadKey);
            sentContentKeys.add(contentKey);
            const reply = resolveSendableOutboundReplyParts(payload);
            for (const mediaUrl of reply.mediaUrls) {
                sentMediaUrls.add(mediaUrl);
            }
            if (!reply.hasMedia && reply.trimmedText) {
                streamedTextFragments.push(reply.trimmedText);
            }
            didStream = true;
        })
            .catch((err) => {
            if (err === timeoutError) {
                abortController.abort();
                aborted = true;
                if (!didLogTimeout) {
                    didLogTimeout = true;
                    logVerbose(`block reply delivery timed out after ${timeoutMs}ms; skipping remaining block replies to preserve ordering`);
                }
                return;
            }
            logVerbose(`block reply delivery failed: ${String(err)}`);
        })
            .finally(() => {
            pendingKeys.delete(payloadKey);
        });
    };
    const coalescer = coalescing
        ? createBlockReplyCoalescer({
            config: coalescing,
            shouldAbort: () => aborted,
            onFlush: (payload) => {
                bufferedAssistantMessageIndex = undefined;
                bufferedKeys.clear();
                sendPayload(payload, /* bypassSeenCheck */ true);
            },
        })
        : null;
    const bufferPayload = (payload) => {
        buffer?.onEnqueue?.(payload);
        if (!buffer?.shouldBuffer(payload)) {
            return false;
        }
        const payloadKey = createBlockReplyPayloadKey(payload);
        if (hasSeenOrQueuedPayloadKey(payloadKey) || bufferedPayloadKeys.has(payloadKey)) {
            return true;
        }
        seenKeys.add(payloadKey);
        bufferedPayloadKeys.add(payloadKey);
        bufferedPayloads.push(payload);
        return true;
    };
    const flushBuffered = () => {
        if (!bufferedPayloads.length) {
            return;
        }
        for (const payload of bufferedPayloads) {
            const finalPayload = buffer?.finalize?.(payload) ?? payload;
            sendPayload(finalPayload, /* bypassSeenCheck */ true);
        }
        bufferedPayloads.length = 0;
        bufferedPayloadKeys.clear();
    };
    const enqueue = (payload) => {
        if (aborted) {
            return;
        }
        if (bufferPayload(payload)) {
            return;
        }
        const hasMedia = resolveSendableOutboundReplyParts(payload).hasMedia;
        if (hasMedia) {
            void coalescer?.flush({ force: true });
            sendPayload(payload, /* bypassSeenCheck */ false);
            return;
        }
        if (coalescer) {
            const assistantMessageIndex = getReplyPayloadMetadata(payload)?.assistantMessageIndex;
            if (assistantMessageIndex !== undefined &&
                bufferedAssistantMessageIndex !== undefined &&
                assistantMessageIndex !== bufferedAssistantMessageIndex &&
                coalescer.hasBuffered()) {
                // Logical assistant blocks must not be merged together by the generic
                // coalescer. Force-flush the previous buffered block before starting a
                // new assistant-message block.
                flushBufferedAssistantBlock();
            }
            const payloadKey = createBlockReplyPayloadKey(payload);
            if (hasSeenOrQueuedPayloadKey(payloadKey) || bufferedKeys.has(payloadKey)) {
                return;
            }
            seenKeys.add(payloadKey);
            bufferedKeys.add(payloadKey);
            bufferedAssistantMessageIndex = assistantMessageIndex;
            coalescer.enqueue(payload);
            return;
        }
        sendPayload(payload, /* bypassSeenCheck */ false);
    };
    const flush = async (options) => {
        await coalescer?.flush(options);
        bufferedAssistantMessageIndex = undefined;
        flushBuffered();
        await sendChain;
    };
    const stop = () => {
        coalescer?.stop();
    };
    return {
        enqueue,
        flush,
        stop,
        hasBuffered: () => coalescer?.hasBuffered() || bufferedPayloads.length > 0,
        didStream: () => didStream,
        isAborted: () => aborted,
        hasSentPayload: (payload) => {
            const payloadKey = createBlockReplyContentKey(payload);
            if (sentContentKeys.has(payloadKey)) {
                return true;
            }
            if (!didStream || streamedTextFragments.length === 0) {
                return false;
            }
            const reply = resolveSendableOutboundReplyParts(payload);
            if (reply.hasMedia || !reply.trimmedText) {
                return false;
            }
            const normalize = (text) => text.replace(/\s+/g, "");
            return normalize(streamedTextFragments.join("")) === normalize(reply.trimmedText);
        },
        getSentMediaUrls: () => Array.from(sentMediaUrls),
    };
}
