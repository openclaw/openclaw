import { clampPositiveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { logVerbose } from "../../globals.js";
import { runAbortableTimeout } from "../../node-host/with-timeout.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  isReplyPayloadStatusNotice,
  isReplyPayloadTerminalContent,
  readReplyPayloadSourceOccurrence,
} from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { createBlockReplyCoalescer } from "./block-reply-coalescer.js";
import { deliverBlockReply, hasBlockReplyDeliveryCustody } from "./block-reply-delivery.js";
import type { BlockReplySource } from "./block-reply-source.types.js";
import type { BlockStreamingCoalescing } from "./block-streaming.js";
import { resolveReplyDispatchErrorOutcome } from "./reply-dispatch-outcome.js";

export type BlockReplyPipeline = {
  enqueue: (payload: ReplyPayload) => void;
  flush: (options?: { force?: boolean }) => Promise<void>;
  stop: () => void;
  hasBuffered: () => boolean;
  didStream: () => boolean;
  /** True only after a final-answer lane payload is sent. */
  didStreamTerminalReply?: (minimumAssistantMessageIndex?: number) => boolean;
  isAborted: () => boolean;
  hasSentPayload: (payload: ReplyPayload) => boolean;
  getSourceRecovery?: (payload: ReplyPayload) => readonly BlockReplySource[] | undefined;
  hasSentExactPayload?: (payload: ReplyPayload) => boolean;
  isFinalPayloadRetryBlocked?: (payload: ReplyPayload) => boolean;
  getSentMediaUrls: () => readonly string[];
  getRetryBlockedMediaUrls?: () => readonly string[];
  hasRetryBlockedTerminalDelivery?: (minimumAssistantMessageIndex?: number) => boolean;
  hasRetryBlockedDelivery: () => boolean;
};

function createBlockReplyContentIdentity(payload: ReplyPayload) {
  const reply = resolveSendableOutboundReplyParts(payload);
  return {
    text: reply.trimmedText,
    mediaList: reply.mediaUrls,
    presentation: payload.presentation ?? null,
    presentationTextMode: payload.presentationTextMode ?? null,
    interactive: payload.interactive ?? null,
    channelData: payload.channelData ?? null,
    location: payload.location ?? null,
    videoAsNote: payload.videoAsNote === true,
  };
}

function createBlockReplyPayloadKey(payload: ReplyPayload): string {
  return JSON.stringify({
    ...createBlockReplyContentIdentity(payload),
    statusNotice: isReplyPayloadStatusNotice(payload),
    reasoning: payload.isReasoning === true,
    commentary: payload.isCommentary === true,
    assistantMessageIndex: getReplyPayloadMetadata(payload)?.assistantMessageIndex ?? null,
    replyToId: payload.replyToId ?? null,
  });
}

export function createBlockReplyContentKey(payload: ReplyPayload): string {
  // Content-only key used for final-payload suppression after block streaming.
  // This intentionally ignores replyToId so a streamed threaded payload and the
  // later final payload still collapse when they carry the same content.
  return JSON.stringify(createBlockReplyContentIdentity(payload));
}

function createIndexedBlockReplyContentKey(payload: ReplyPayload): string {
  const contentKey = createBlockReplyContentKey(payload);
  const assistantMessageIndex = getReplyPayloadMetadata(payload)?.assistantMessageIndex;
  return assistantMessageIndex === undefined
    ? contentKey
    : `${assistantMessageIndex}:${contentKey}`;
}

export function createBlockReplyPipeline(params: {
  onBlockReply: (
    payload: ReplyPayload,
    options?: { abortSignal?: AbortSignal; timeoutMs?: number },
  ) => Promise<void> | void;
  timeoutMs: number;
  coalescing?: BlockStreamingCoalescing;
  /** Buffer audio until its voice presentation metadata has arrived. */
  isAudioPayload?: (payload: ReplyPayload) => boolean;
}): BlockReplyPipeline {
  const { onBlockReply, coalescing, isAudioPayload } = params;
  const timeoutMs = clampPositiveTimerTimeoutMs(params.timeoutMs) ?? 0;
  const sentKeys = new Set<string>();
  const sentContentKeys = new Set<string>();
  const sentMediaUrls = new Set<string>();
  const pendingKeys = new Set<string>();
  const seenKeys = new Set<string>();
  const bufferedPayloads: ReplyPayload[] = [];
  let seenAudioAsVoice = false;
  type BlockAttempt = Awaited<ReturnType<typeof deliverBlockReply>> & {
    sourceText: string;
    contentKey: string;
    mediaUrls: readonly string[];
    terminal: boolean;
    messageStart?: number;
    terminalDeliveryConfirmed?: true;
  };
  const blockAttemptsByMessage = new Map<number | undefined, BlockAttempt[]>();
  let bufferedAssistantMessageIndex: number | undefined;
  let sendChain: Promise<void> = Promise.resolve();
  let aborted = false;
  let didStream = false;

  const hasSeenOrQueuedPayloadKey = (payloadKey: string) =>
    seenKeys.has(payloadKey) || sentKeys.has(payloadKey) || pendingKeys.has(payloadKey);
  const resolveDedupeIdentity = (payload: ReplyPayload, payloadKey: string) => {
    const sourceText = getReplyPayloadMetadata(payload)?.blockSourceText;
    const occurrence = readReplyPayloadSourceOccurrence(payload);
    const occurrenceKey = occurrence ? JSON.stringify(occurrence) : undefined;
    return {
      sourceText,
      occurrenceKey,
      key: occurrenceKey ?? payloadKey,
      unkeyedSource: sourceText !== undefined && occurrenceKey === undefined,
    };
  };

  const flushBufferedAssistantBlock = () => {
    bufferedAssistantMessageIndex = undefined;
    void coalescer?.flush({ force: true });
  };

  const sendPayload = (payload: ReplyPayload, bypassSeenCheck: boolean) => {
    if (aborted) {
      return;
    }
    const payloadKey = createBlockReplyPayloadKey(payload);
    const contentKey = createBlockReplyContentKey(payload);
    const identity = resolveDedupeIdentity(payload, payloadKey);
    if (!bypassSeenCheck && !identity.unkeyedSource) {
      if (seenKeys.has(identity.key)) {
        return;
      }
      seenKeys.add(identity.key);
    }
    if (identity.occurrenceKey) {
      seenKeys.add(payloadKey);
    }
    if (!identity.unkeyedSource && (sentKeys.has(identity.key) || pendingKeys.has(identity.key))) {
      return;
    }
    pendingKeys.add(identity.key);
    const isTerminalContent = isReplyPayloadTerminalContent(payload);
    const reply = resolveSendableOutboundReplyParts(payload);
    const metadata = getReplyPayloadMetadata(payload);
    const attempt: BlockAttempt = {
      outcome: "cancelled",
      sourceText: identity.sourceText ?? reply.trimmedText,
      contentKey,
      mediaUrls: reply.mediaUrls,
      terminal: isTerminalContent && hasOutboundReplyContent(payload, { trimText: true }),
      messageStart: metadata?.assistantMessageStartIndex,
    };
    const index = metadata?.assistantMessageIndex;
    const attempts = blockAttemptsByMessage.get(index) ?? [];
    attempts.push(attempt);
    blockAttemptsByMessage.set(index, attempts);

    // Preserve outbound order by chaining sends; abort after timeout to avoid stale blocks.
    const fallbackAbortController = new AbortController();
    let timeoutSignal: AbortSignal | undefined;
    sendChain = sendChain
      .then(async () => {
        if (aborted) {
          return false;
        }
        attempt.outcome = "failed-deliver";
        attempt.pending = true;
        return await runAbortableTimeout(
          async (signal) => {
            timeoutSignal = signal;
            return await deliverBlockReply(() =>
              onBlockReply(payload, {
                abortSignal: signal ?? fallbackAbortController.signal,
                timeoutMs,
              }),
            );
          },
          timeoutMs || undefined,
          "block reply delivery",
        );
      })
      .then((delivery) => {
        if (!delivery) {
          return;
        }
        Object.assign(attempt, delivery, { pending: delivery.pending === true });
        const isStatusNotice = isReplyPayloadStatusNotice(payload);
        if (delivery.outcome !== "delivered" || delivery.pending) {
          return;
        }
        if (delivery.source?.complete !== false) {
          sentKeys.add(identity.key);
          if (isTerminalContent) {
            if (attempt.terminal) {
              attempt.terminalDeliveryConfirmed = true;
            }
            sentContentKeys.add(contentKey);
            sentContentKeys.add(createIndexedBlockReplyContentKey(payload));
          }
        }
        for (const mediaUrl of reply.mediaUrls) {
          sentMediaUrls.add(mediaUrl);
        }
        if (!isStatusNotice) {
          didStream = true;
        }
      })
      .catch((err: unknown) => {
        if (timeoutSignal?.aborted) {
          aborted = true;
          logVerbose(
            `block reply delivery timed out after ${timeoutMs}ms; skipping remaining block replies to preserve ordering`,
          );
          return;
        }
        attempt.outcome = resolveReplyDispatchErrorOutcome(err);
        attempt.pending = false;
        logVerbose(`block reply delivery failed: ${String(err)}`);
      })
      .finally(() => {
        pendingKeys.delete(identity.key);
      });
  };

  const coalescer = coalescing
    ? createBlockReplyCoalescer({
        config: coalescing,
        shouldAbort: () => aborted,
        onFlush: (payload) => {
          bufferedAssistantMessageIndex = undefined;
          sendPayload(payload, /* bypassSeenCheck */ true);
        },
      })
    : null;

  const bufferPayload = (payload: ReplyPayload) => {
    seenAudioAsVoice ||= Boolean(payload.audioAsVoice);
    if (!isAudioPayload?.(payload)) {
      return false;
    }
    const payloadKey = createBlockReplyPayloadKey(payload);
    if (hasSeenOrQueuedPayloadKey(payloadKey)) {
      return true;
    }
    seenKeys.add(payloadKey);
    bufferedPayloads.push(payload);
    return true;
  };

  const flushBuffered = () => {
    for (const payload of bufferedPayloads) {
      const finalPayload = seenAudioAsVoice
        ? copyReplyPayloadMetadata(payload, { ...payload, audioAsVoice: true })
        : payload;
      sendPayload(finalPayload, /* bypassSeenCheck */ true);
    }
    bufferedPayloads.length = 0;
  };

  const enqueueCoalescedPayload = (payload: ReplyPayload) => {
    if (!coalescer) {
      return;
    }
    const assistantMessageIndex = getReplyPayloadMetadata(payload)?.assistantMessageIndex;
    if (
      assistantMessageIndex !== undefined &&
      bufferedAssistantMessageIndex !== undefined &&
      assistantMessageIndex !== bufferedAssistantMessageIndex &&
      coalescer.hasBuffered()
    ) {
      // Logical assistant blocks must not be merged together by the generic
      // coalescer. Force-flush the previous buffered block before starting a
      // new assistant-message block.
      flushBufferedAssistantBlock();
    }
    const payloadKey = createBlockReplyPayloadKey(payload);
    const identity = resolveDedupeIdentity(payload, payloadKey);
    if (!identity.unkeyedSource && hasSeenOrQueuedPayloadKey(identity.key)) {
      return;
    }
    if (!identity.unkeyedSource) {
      seenKeys.add(identity.key);
    }
    if (identity.occurrenceKey) {
      seenKeys.add(payloadKey);
    }
    bufferedAssistantMessageIndex = assistantMessageIndex;
    coalescer.enqueue(payload);
  };

  const enqueue = (payload: ReplyPayload) => {
    if (aborted) {
      return;
    }
    if (bufferPayload(payload)) {
      flushBufferedAssistantBlock();
      return;
    }
    // Buffered audio is an ordering boundary, even when voice metadata arrives later.
    flushBuffered();
    const hasNonTextContent = hasOutboundReplyContent(
      { ...payload, text: undefined, mediaUrl: undefined, mediaUrls: undefined },
      { trimText: true },
    );
    if (coalescer && !hasNonTextContent) {
      enqueueCoalescedPayload(payload);
      return;
    }
    void coalescer?.flush({ force: true });
    sendPayload(payload, /* bypassSeenCheck */ false);
  };

  const flush = async (options?: { force?: boolean }) => {
    await coalescer?.flush(options);
    bufferedAssistantMessageIndex = undefined;
    flushBuffered();
    await sendChain;
  };

  // A final payload joins every text item of its physical assistant message, and each item
  // streamed under its own index (hidden commentary items take indexes without blocks), so
  // also match item runs back to the message start.
  const matchingTerminalAttempts = function* (payload: ReplyPayload) {
    const index = getReplyPayloadMetadata(payload)?.assistantMessageIndex;
    if (index === undefined) {
      for (const attempts of blockAttemptsByMessage.values()) {
        yield attempts.filter((attempt) => attempt.terminal);
      }
      return;
    }
    const start = blockAttemptsByMessage.get(index)?.[0]?.messageStart ?? index;
    for (let item = index, run: BlockAttempt[] = []; item >= start; item--) {
      const attempts = blockAttemptsByMessage.get(item);
      if (attempts?.length) {
        run = [...attempts.filter((attempt) => attempt.terminal), ...run];
        yield run;
      }
    }
  };
  const normalizeSource = (text: string) => text.replace(/\s+/g, "");
  const combinedSource = (attempts: BlockAttempt[]) =>
    normalizeSource(attempts.map((attempt) => attempt.sourceText).join(""));
  const hasAttempt = (
    predicate: (attempt: BlockAttempt) => boolean,
    minimumAssistantMessageIndex?: number,
  ) => {
    for (const [index, attempts] of blockAttemptsByMessage) {
      if (
        (minimumAssistantMessageIndex === undefined ||
          (index ?? 0) >= minimumAssistantMessageIndex) &&
        attempts.some(predicate)
      ) {
        return true;
      }
    }
    return false;
  };

  return {
    enqueue,
    flush,
    stop: () => coalescer?.stop(),
    hasBuffered: () => coalescer?.hasBuffered() || bufferedPayloads.length > 0,
    didStream: () => didStream,
    didStreamTerminalReply: (minimumAssistantMessageIndex = 0) =>
      hasAttempt(
        (attempt) => attempt.terminalDeliveryConfirmed === true,
        minimumAssistantMessageIndex,
      ),
    isAborted: () => aborted,
    hasSentExactPayload: (payload) =>
      sentContentKeys.has(createIndexedBlockReplyContentKey(payload)),
    getSourceRecovery: (payload) => {
      const text = normalizeSource(resolveSendableOutboundReplyParts(payload).trimmedText);
      for (const attempts of matchingTerminalAttempts(payload)) {
        if (
          text &&
          combinedSource(attempts) === text &&
          attempts.some((attempt) => attempt.source?.complete === false)
        ) {
          return Array.from(new Set(attempts.flatMap((attempt) => attempt.source ?? [])));
        }
      }
      return undefined;
    },
    isFinalPayloadRetryBlocked: (payload) => {
      const contentKey = createBlockReplyContentKey(payload);
      const reply = resolveSendableOutboundReplyParts(payload);
      const text = normalizeSource(reply.trimmedText);
      const textOnly = !hasOutboundReplyContent({ ...payload, text: undefined });
      for (const attempts of matchingTerminalAttempts(payload)) {
        const blocked = attempts.filter(hasBlockReplyDeliveryCustody);
        const sourcePrefix = combinedSource(attempts);
        if (
          blocked.some((attempt) => attempt.contentKey === contentKey) ||
          (textOnly &&
            blocked.length > 0 &&
            sourcePrefix.length > 0 &&
            text.startsWith(sourcePrefix))
        ) {
          return true;
        }
      }
      return false;
    },
    hasSentPayload: (payload) => {
      const payloadKey = createIndexedBlockReplyContentKey(payload);
      if (sentContentKeys.has(payloadKey)) {
        return true;
      }
      if (!didStream) {
        return false;
      }
      const reply = resolveSendableOutboundReplyParts(payload);
      if (reply.hasMedia || !reply.trimmedText) {
        return false;
      }
      const sourceText = normalizeSource(reply.trimmedText);
      for (const group of matchingTerminalAttempts(payload)) {
        const attempts = group.filter(
          (attempt) =>
            attempt.outcome === "delivered" &&
            !attempt.pending &&
            attempt.source?.complete !== false,
        );
        if (attempts.length > 0 && combinedSource(attempts) === sourceText) {
          return true;
        }
      }
      return false;
    },
    getSentMediaUrls: () => Array.from(sentMediaUrls),
    hasRetryBlockedDelivery: () => hasAttempt(hasBlockReplyDeliveryCustody),
    hasRetryBlockedTerminalDelivery: (minimumAssistantMessageIndex = 0) =>
      hasAttempt(
        (attempt) => attempt.terminal && hasBlockReplyDeliveryCustody(attempt),
        minimumAssistantMessageIndex,
      ),
    getRetryBlockedMediaUrls: () =>
      Array.from(
        new Set(
          Array.from(blockAttemptsByMessage.values()).flatMap((attempts) =>
            attempts.filter(hasBlockReplyDeliveryCustody).flatMap((attempt) => attempt.mediaUrls),
          ),
        ),
      ),
  };
}
