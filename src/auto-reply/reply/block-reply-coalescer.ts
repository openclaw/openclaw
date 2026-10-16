import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  isReplyPayloadStatusNotice,
  setReplyPayloadMetadata,
  type ReplyPayloadMetadata,
} from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import type { BlockStreamingCoalescing } from "./block-streaming.js";

export function createBlockReplyCoalescer(params: {
  config: BlockStreamingCoalescing;
  shouldAbort: () => boolean;
  onFlush: (payload: ReplyPayload) => Promise<void> | void;
}) {
  const { config, shouldAbort, onFlush } = params;
  const minChars = Math.max(1, Math.floor(config.minChars));
  const maxChars = Math.max(minChars, Math.floor(config.maxChars));
  const idleMs = Math.max(0, Math.floor(config.idleMs));
  const joiner = config.joiner ?? "";

  let bufferText = "";
  let bufferSource: Pick<ReplyPayloadMetadata, "blockSourceText" | "blockSourceRange"> = {};
  let bufferedPayload: ReplyPayload | undefined;
  let idleTimer: NodeJS.Timeout | undefined;

  const clearIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const resetBuffer = () => {
    bufferText = "";
    bufferSource = {};
    bufferedPayload = undefined;
  };

  const scheduleIdleFlush = () => {
    if (idleMs <= 0) {
      return;
    }
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      void flush({ force: false });
    }, idleMs);
  };

  const flush = async (options?: { force?: boolean }) => {
    clearIdleTimer();
    if (shouldAbort()) {
      resetBuffer();
      return;
    }
    if (!bufferText || !bufferedPayload) {
      return;
    }
    if (!options?.force && bufferText.length < minChars) {
      scheduleIdleFlush();
      return;
    }
    const payload = setReplyPayloadMetadata(
      copyReplyPayloadMetadata(bufferedPayload, {
        ...bufferedPayload,
        text: bufferText,
      }),
      bufferSource,
    );
    resetBuffer();
    await onFlush(payload);
  };

  const canMergeBufferedTextWithMedia = (payload: ReplyPayload) =>
    Boolean(bufferText) &&
    bufferedPayload !== undefined &&
    [bufferedPayload, payload].every(
      (part) =>
        !part.audioAsVoice &&
        !part.isReasoning &&
        !part.isCommentary &&
        !isReplyPayloadStatusNotice(part),
    ) &&
    (!payload.replyToId || bufferedPayload.replyToId === payload.replyToId);

  const mergeSource = (text: string, source: typeof bufferSource): typeof bufferSource => ({
    // Source coverage excludes the transport joiner.
    blockSourceText:
      bufferSource.blockSourceText !== undefined || source.blockSourceText !== undefined
        ? (bufferSource.blockSourceText ?? bufferText) + (source.blockSourceText ?? text)
        : undefined,
    blockSourceRange:
      bufferSource.blockSourceRange && source.blockSourceRange
        ? [bufferSource.blockSourceRange[0], source.blockSourceRange[1]]
        : (bufferSource.blockSourceRange ?? source.blockSourceRange),
  });

  const mergeBufferedTextWithMedia = (payload: ReplyPayload, text: string): ReplyPayload => {
    const mergedText = text ? `${bufferText}${joiner}${text}` : bufferText;
    const mergedSource = mergeSource(text, text ? (getReplyPayloadMetadata(payload) ?? {}) : {});
    const mergedPayload: ReplyPayload = {
      ...bufferedPayload,
      ...payload,
      text: mergedText,
      replyToId: payload.replyToId ?? bufferedPayload?.replyToId,
      replyToCurrent: payload.replyToCurrent || bufferedPayload?.replyToCurrent,
      replyToTag: payload.replyToTag || bufferedPayload?.replyToTag,
    };
    const metadataMergedPayload = copyReplyPayloadMetadata(
      bufferedPayload ?? mergedPayload,
      mergedPayload,
    );
    resetBuffer();
    return setReplyPayloadMetadata(
      copyReplyPayloadMetadata(payload, metadataMergedPayload),
      mergedSource,
    );
  };

  const enqueue = (payload: ReplyPayload) => {
    if (shouldAbort()) {
      return;
    }
    const reply = resolveSendableOutboundReplyParts(payload);
    const text = reply.text;
    const source = {
      blockSourceText: getReplyPayloadMetadata(payload)?.blockSourceText,
      blockSourceRange: getReplyPayloadMetadata(payload)?.blockSourceRange,
    };
    if (reply.hasMedia) {
      if (canMergeBufferedTextWithMedia(payload)) {
        void onFlush(mergeBufferedTextWithMedia(payload, text));
        return;
      }
      void flush({ force: true });
      void onFlush(payload);
      return;
    }
    if (!reply.hasText) {
      return;
    }

    const replyToConflict = Boolean(
      payload.replyToId && bufferedPayload?.replyToId !== payload.replyToId,
    );
    const visibilityConflict =
      bufferedPayload &&
      (bufferedPayload.isReasoning !== payload.isReasoning ||
        bufferedPayload.isCommentary !== payload.isCommentary ||
        bufferedPayload.isCompactionNotice !== payload.isCompactionNotice ||
        bufferedPayload.isFallbackNotice !== payload.isFallbackNotice ||
        isReplyPayloadStatusNotice(bufferedPayload) !== isReplyPayloadStatusNotice(payload));
    // Flush before changing reply target, audio mode, or visibility class.
    if (
      bufferText &&
      (replyToConflict ||
        bufferedPayload?.audioAsVoice !== payload.audioAsVoice ||
        visibilityConflict)
    ) {
      void flush({ force: true });
    }

    if (!bufferText) {
      bufferedPayload = payload;
    }

    let nextText = bufferText ? `${bufferText}${joiner}${text}` : text;
    const replaceSource = nextText.length > maxChars;
    if (replaceSource) {
      if (bufferText) {
        void flush({ force: true });
        bufferedPayload = payload;
      }
      if (text.length >= maxChars) {
        void onFlush(payload);
        return;
      }
      nextText = text;
    }

    // Overflow replaces even a buffer populated by synchronous onFlush reentry.
    bufferSource = replaceSource ? source : mergeSource(text, source);
    bufferText = nextText;
    if (bufferText.length >= maxChars) {
      void flush({ force: true });
      return;
    }
    scheduleIdleFlush();
  };

  return {
    enqueue,
    flush,
    hasBuffered: () => Boolean(bufferText),
    stop: clearIdleTimer,
  };
}
