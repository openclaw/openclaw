import { logVerbose } from "../../globals.js";
import type { ReplyPayload } from "../types.js";
import { createBlockReplyCoalescer } from "./block-reply-coalescer.js";
import type { BlockStreamingCoalescing } from "./block-streaming.js";

export type BlockReplyPipeline = {
  enqueue: (payload: ReplyPayload) => void;
  flush: (options?: { force?: boolean }) => Promise<void>;
  stop: () => void;
  hasBuffered: () => boolean;
  didStream: () => boolean;
  isAborted: () => boolean;
  hasSentPayload: (payload: ReplyPayload) => boolean;
};

export function createBlockReplyPayloadKey(payload: ReplyPayload): string {
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

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutError: Error,
): Promise<T> => {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export function createBlockReplyPipeline(params: {
  onBlockReply: (
    payload: ReplyPayload,
    options?: { abortSignal?: AbortSignal; timeoutMs?: number },
  ) => Promise<void> | void;
  timeoutMs: number;
  coalescing?: BlockStreamingCoalescing;
}): BlockReplyPipeline {
  const { onBlockReply, timeoutMs, coalescing } = params;
  const sentKeys = new Set<string>();
  const pendingKeys = new Set<string>();
  const seenKeys = new Set<string>();
  const bufferedKeys = new Set<string>();
  let sendChain: Promise<void> = Promise.resolve();
  let aborted = false;
  let didStream = false;
  let didLogTimeout = false;

  const sendPayload = (payload: ReplyPayload, skipSeen?: boolean) => {
    if (aborted) return;
    const payloadKey = createBlockReplyPayloadKey(payload);
    if (!skipSeen) {
      if (seenKeys.has(payloadKey)) return;
      seenKeys.add(payloadKey);
    }
    if (sentKeys.has(payloadKey) || pendingKeys.has(payloadKey)) return;
    pendingKeys.add(payloadKey);

    const timeoutError = new Error(
      `block reply delivery timed out after ${timeoutMs}ms`,
    );
    const abortController = new AbortController();
    sendChain = sendChain
      .then(async () => {
        if (aborted) return false;
        await withTimeout(
          onBlockReply(payload, {
            abortSignal: abortController.signal,
            timeoutMs,
          }) ?? Promise.resolve(),
          timeoutMs,
          timeoutError,
        );
        return true;
      })
      .then((didSend) => {
        if (!didSend) return;
        sentKeys.add(payloadKey);
        didStream = true;
      })
      .catch((err) => {
        if (err === timeoutError) {
          abortController.abort();
          aborted = true;
          if (!didLogTimeout) {
            didLogTimeout = true;
            logVerbose(
              `block reply delivery timed out after ${timeoutMs}ms; skipping remaining block replies to preserve ordering`,
            );
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
          sendPayload(payload);
        },
      })
    : null;

  const enqueue = (payload: ReplyPayload) => {
    if (aborted) return;
    const hasMedia =
      Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
    if (hasMedia) {
      void coalescer?.flush({ force: true });
      sendPayload(payload);
      return;
    }
    if (coalescer) {
      const payloadKey = createBlockReplyPayloadKey(payload);
      if (
        seenKeys.has(payloadKey) ||
        pendingKeys.has(payloadKey) ||
        bufferedKeys.has(payloadKey)
      ) {
        return;
      }
      bufferedKeys.add(payloadKey);
      coalescer.enqueue(payload);
      return;
    }
    sendPayload(payload);
  };

  const flush = async (options?: { force?: boolean }) => {
    await coalescer?.flush(options);
    await sendChain;
  };

  const stop = () => {
    coalescer?.stop();
  };

  return {
    enqueue,
    flush,
    stop,
    hasBuffered: () => Boolean(coalescer?.hasBuffered()),
    didStream: () => didStream,
    isAborted: () => aborted,
    hasSentPayload: (payload) => {
      const payloadKey = createBlockReplyPayloadKey(payload);
      return sentKeys.has(payloadKey);
    },
  };
}
