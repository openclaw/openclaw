import { logVerbose } from "../../globals.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { BlockReplyContext, ReplyPayload } from "../types.js";
import type { BlockReplyPipeline } from "./block-reply-pipeline.js";
import { createBlockReplyContentKey } from "./block-reply-pipeline.js";
import { parseReplyDirectives } from "./reply-directives.js";
import { applyReplyTagsToPayload, isRenderablePayload } from "./reply-payloads.js";
import type { TypingSignaler } from "./typing-mode.js";

export type ReplyDirectiveParseMode = "always" | "auto" | "never";

export function normalizeReplyPayloadDirectives(params: {
  payload: ReplyPayload;
  currentMessageId?: string;
  silentToken?: string;
  trimLeadingWhitespace?: boolean;
  parseMode?: ReplyDirectiveParseMode;
}): { payload: ReplyPayload; isSilent: boolean } {
  const parseMode = params.parseMode ?? "always";
  const silentToken = params.silentToken ?? SILENT_REPLY_TOKEN;
  const sourceText = params.payload.text ?? "";

  const shouldParse =
    parseMode === "always" ||
    (parseMode === "auto" &&
      (sourceText.includes("[[") ||
        sourceText.includes("MEDIA:") ||
        sourceText.includes(silentToken)));

  const parsed = shouldParse
    ? parseReplyDirectives(sourceText, {
        currentMessageId: params.currentMessageId,
        silentToken,
      })
    : undefined;

  let text = parsed ? parsed.text || undefined : params.payload.text || undefined;
  if (params.trimLeadingWhitespace && text) {
    text = text.trimStart() || undefined;
  }

  const mediaUrls = params.payload.mediaUrls ?? parsed?.mediaUrls;
  const mediaUrl = params.payload.mediaUrl ?? parsed?.mediaUrl ?? mediaUrls?.[0];

  return {
    payload: {
      ...params.payload,
      text,
      mediaUrls,
      mediaUrl,
      replyToId: params.payload.replyToId ?? parsed?.replyToId,
      replyToTag: params.payload.replyToTag || parsed?.replyToTag,
      replyToCurrent: params.payload.replyToCurrent || parsed?.replyToCurrent,
      audioAsVoice: Boolean(params.payload.audioAsVoice || parsed?.audioAsVoice),
    },
    isSilent: parsed?.isSilent ?? false,
  };
}

const hasRenderableMedia = (payload: ReplyPayload): boolean =>
  Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;

export function createBlockReplyDeliveryHandler(params: {
  onBlockReply: (payload: ReplyPayload, context?: BlockReplyContext) => Promise<void> | void;
  currentMessageId?: string;
  normalizeStreamingText: (payload: ReplyPayload) => { text?: string; skip: boolean };
  applyReplyToMode: (payload: ReplyPayload) => ReplyPayload;
  normalizeMediaPaths?: (payload: ReplyPayload) => Promise<ReplyPayload>;
  typingSignals: TypingSignaler;
  blockStreamingEnabled: boolean;
  blockReplyPipeline: BlockReplyPipeline | null;
  directlySentBlockKeys: Set<string>;
}): (payload: ReplyPayload) => Promise<void> {
  return async (payload) => {
    const { text, skip } = params.normalizeStreamingText(payload);
    if (skip && !hasRenderableMedia(payload)) {
      return;
    }

    const taggedPayload = applyReplyTagsToPayload(
      {
        ...payload,
        text,
        mediaUrl: payload.mediaUrl ?? payload.mediaUrls?.[0],
        replyToId:
          payload.replyToId ??
          (payload.replyToCurrent === false ? undefined : params.currentMessageId),
      },
      params.currentMessageId,
    );

    // Let through payloads with audioAsVoice flag even if empty (need to track it).
    if (!isRenderablePayload(taggedPayload) && !payload.audioAsVoice) {
      return;
    }

    const normalized = normalizeReplyPayloadDirectives({
      payload: taggedPayload,
      currentMessageId: params.currentMessageId,
      silentToken: SILENT_REPLY_TOKEN,
      trimLeadingWhitespace: true,
      parseMode: "auto",
    });

    const mediaNormalizedPayload = params.normalizeMediaPaths
      ? await params.normalizeMediaPaths(normalized.payload)
      : normalized.payload;
    const blockPayload = params.applyReplyToMode(mediaNormalizedPayload);
    const blockHasMedia = hasRenderableMedia(blockPayload);

    // Skip empty payloads unless they have audioAsVoice flag (need to track it).
    if (!blockPayload.text && !blockHasMedia && !blockPayload.audioAsVoice) {
      return;
    }
    if (normalized.isSilent && !blockHasMedia) {
      return;
    }
    // When block streaming is disabled entirely, blocks are accumulated in final text instead.
    if (!params.blockStreamingEnabled) {
      return;
    }

    // Apply plugin outbound transforms to block-streamed text for delivery,
    // but use the pre-transform payload for dedup keys so they match final payloads.
    const hookRunner = getGlobalHookRunner();
    const deliveryPayload =
      hookRunner && typeof blockPayload.text === "string"
        ? { ...blockPayload, text: hookRunner.runOutboundTransforms(blockPayload.text) }
        : blockPayload;

    if (deliveryPayload.text) {
      void params.typingSignals.signalTextDelta(deliveryPayload.text).catch((err) => {
        logVerbose(`block reply typing signal failed: ${String(err)}`);
      });
    }

    // Use pipeline if available (block streaming enabled), otherwise send directly.
    if (params.blockStreamingEnabled && params.blockReplyPipeline) {
      params.blockReplyPipeline.enqueue(deliveryPayload);
    } else if (params.blockStreamingEnabled) {
      // Send directly when flushing before tool execution (no pipeline but streaming enabled).
      // Track sent key from pre-transform text to avoid duplicate in final payloads.
      params.directlySentBlockKeys.add(createBlockReplyContentKey(blockPayload));
      await params.onBlockReply(deliveryPayload);
    }
  };
}
