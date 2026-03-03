import { logVerbose } from "../../globals.js";
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
    const text = payload.text?.trim() ?? "";
    const mediaList = payload.mediaUrls?.length
        ? payload.mediaUrls
        : payload.mediaUrl
            ? [payload.mediaUrl]
            : [];
    return JSON.stringify({
        text,
        mediaList,
        replyToId: payload.replyToId ?? null,
    });
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
    const pendingKeys = new Set();
    const seenKeys = new Set();
    const bufferedKeys = new Set();
    const bufferedPayloadKeys = new Set();
    const bufferedPayloads = [];
    let sendChain = Promise.resolve();
    let aborted = false;
    let didStream = false;
    let didLogTimeout = false;
    const sendPayload = (payload, bypassSeenCheck = false) => {
        if (aborted) {
            return;
        }
        const payloadKey = createBlockReplyPayloadKey(payload);
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
        if (seenKeys.has(payloadKey) ||
            sentKeys.has(payloadKey) ||
            pendingKeys.has(payloadKey) ||
            bufferedPayloadKeys.has(payloadKey)) {
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
        const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
        if (hasMedia) {
            void coalescer?.flush({ force: true });
            sendPayload(payload, /* bypassSeenCheck */ false);
            return;
        }
        if (coalescer) {
            const payloadKey = createBlockReplyPayloadKey(payload);
            if (seenKeys.has(payloadKey) || pendingKeys.has(payloadKey) || bufferedKeys.has(payloadKey)) {
                return;
            }
            seenKeys.add(payloadKey);
            bufferedKeys.add(payloadKey);
            coalescer.enqueue(payload);
            return;
        }
        sendPayload(payload, /* bypassSeenCheck */ false);
    };
    const flush = async (options) => {
        await coalescer?.flush(options);
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
        hasBuffered: () => Boolean(coalescer?.hasBuffered() || bufferedPayloads.length > 0),
        didStream: () => didStream,
        isAborted: () => aborted,
        hasSentPayload: (payload) => {
            const payloadKey = createBlockReplyPayloadKey(payload);
            return sentKeys.has(payloadKey);
        },
    };
}
