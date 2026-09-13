/** Delivers prepared block replies through streaming or direct paths. */
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import { logVerbose } from "../../globals.js";
import { trimTextPreservingCode } from "../../shared/text/text-projection.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  isReplyPayloadTerminalContent,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import { isSilentReplyPayloadText, isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
import type { BlockReplyContext, ReplyPayload, ReplyThreadingPolicy } from "../types.js";
import { deliverBlockReply } from "./block-reply-delivery.js";
import type { BlockReplyPipeline } from "./block-reply-pipeline.js";
import { createBlockReplyContentKey } from "./block-reply-pipeline.js";
import { parseReplyDirectives } from "./reply-directives.js";
import { resolveReplyDispatchErrorOutcome } from "./reply-dispatch-outcome.js";
import { isRenderablePayload } from "./reply-payloads.js";
import type { TypingSignaler } from "./typing-mode.js";

type ReplyDirectiveParseMode = "always" | "auto" | "never";

export type DirectBlockDelivery = Awaited<ReturnType<typeof deliverBlockReply>> & {
  payload: ReplyPayload;
};

/** Parses inline reply directives into payload fields and silent-reply state. */
export function normalizeReplyPayloadDirectives(params: {
  payload: ReplyPayload;
  currentMessageId?: string;
  silentToken?: string;
  trimLeadingWhitespace?: boolean;
  parseMode?: ReplyDirectiveParseMode;
  extractMarkdownImages?: boolean;
  extractMediaDirectives?: boolean;
}): { payload: ReplyPayload; isSilent: boolean } {
  const parseMode = params.parseMode ?? "always";
  const silentToken = params.silentToken ?? SILENT_REPLY_TOKEN;
  const sourceText = params.payload.text ?? "";

  const shouldParse =
    parseMode === "always" ||
    (parseMode === "auto" &&
      (sourceText.includes("[[") ||
        (params.extractMediaDirectives !== false && /media:/i.test(sourceText)) ||
        (params.extractMarkdownImages === true && /!\[[^\]]*]\(/.test(sourceText)) ||
        sourceText.includes(silentToken)));

  const parsed = shouldParse
    ? parseReplyDirectives(sourceText, {
        currentMessageId: params.currentMessageId,
        silentToken,
        extractMarkdownImages: params.extractMarkdownImages,
        extractMediaDirectives: params.extractMediaDirectives,
      })
    : undefined;

  let text = parsed ? parsed.text || undefined : params.payload.text || undefined;
  if (params.trimLeadingWhitespace && text) {
    text = trimTextPreservingCode(text, "start") || undefined;
  }

  const mediaUrls = params.payload.mediaUrls ?? parsed?.mediaUrls;
  const mediaUrl = params.payload.mediaUrl ?? parsed?.mediaUrls?.[0] ?? mediaUrls?.[0];

  return {
    payload: copyReplyPayloadMetadata(params.payload, {
      ...params.payload,
      text,
      mediaUrls,
      mediaUrl,
      replyToId: params.payload.replyToId ?? parsed?.replyToId,
      replyToTag: params.payload.replyToTag || parsed?.replyToTag,
      replyToCurrent: params.payload.replyToCurrent || parsed?.replyToCurrent,
      audioAsVoice: Boolean(params.payload.audioAsVoice || parsed?.audioAsVoice),
    }),
    isSilent: parsed?.isSilent ?? false,
  };
}

async function sendDirectBlockReply(params: {
  onBlockReply: (payload: ReplyPayload, context?: BlockReplyContext) => Promise<void> | void;
  directlySentBlockKeys: Set<string>;
  directBlockDeliveries: DirectBlockDelivery[];
  payload: ReplyPayload;
}) {
  const attempt: DirectBlockDelivery = {
    payload: params.payload,
    outcome: "failed-deliver",
    pending: true,
  };
  params.directBlockDeliveries.push(attempt);
  const delivery = await deliverBlockReply(() => params.onBlockReply(params.payload)).catch(
    (error: unknown) => {
      attempt.outcome = resolveReplyDispatchErrorOutcome(error);
      attempt.pending = false;
      throw error;
    },
  );
  Object.assign(attempt, delivery, { pending: delivery.pending === true });
  if (
    delivery.outcome === "delivered" &&
    !delivery.pending &&
    isReplyPayloadTerminalContent(params.payload)
  ) {
    params.directlySentBlockKeys.add(createBlockReplyContentKey(params.payload));
  }
}

/** Creates the handler used for assistant block replies during streaming/tool phases. */
export function createBlockReplyDeliveryHandler(params: {
  onBlockReply: (payload: ReplyPayload, context?: BlockReplyContext) => Promise<void> | void;
  currentMessageId?: string;
  replyThreading?: ReplyThreadingPolicy;
  normalizeStreamingText: (payload: ReplyPayload) => { text?: string; skip: boolean };
  applyReplyToMode: (payload: ReplyPayload) => ReplyPayload;
  normalizeMediaPaths?: (payload: ReplyPayload) => Promise<ReplyPayload>;
  typingSignals: TypingSignaler;
  reasoningPayloadsEnabled?: boolean;
  commentaryPayloadsEnabled?: boolean;
  blockStreamingEnabled: boolean;
  blockReplyPipeline: BlockReplyPipeline | null;
  directlySentBlockKeys: Set<string>;
  directBlockDeliveries: DirectBlockDelivery[];
}): (payload: ReplyPayload) => Promise<void> {
  return async (payload) => {
    // Suppressed display lanes must not enter delivery bookkeeping: callers use
    // that evidence to decide whether an otherwise empty turn needs a fallback.
    if (
      (payload.isReasoning === true && params.reasoningPayloadsEnabled !== true) ||
      (payload.isCommentary === true && params.commentaryPayloadsEnabled !== true)
    ) {
      return;
    }
    const { text, skip } = params.normalizeStreamingText(payload);
    const isSilent =
      getReplyPayloadMetadata(payload)?.silentReply === true ||
      isSilentReplyText(payload.text, SILENT_REPLY_TOKEN) ||
      (skip && isSilentReplyPayloadText(text, SILENT_REPLY_TOKEN));
    if (
      skip &&
      !hasOutboundReplyContent({ ...payload, text: undefined }) &&
      !payload.audioAsVoice
    ) {
      return;
    }

    const implicitCurrentMessageAllowed =
      payload.replyToCurrent === true
        ? true
        : payload.replyToCurrent === false
          ? false
          : params.replyThreading?.implicitCurrentMessage !== "deny";
    // Reply-to-current is implicit for block replies unless per-turn threading disables it.

    const normalizedText = text ? trimTextPreservingCode(text, "start") : undefined;
    const normalizedPayload = copyReplyPayloadMetadata(payload, {
      ...payload,
      text: isSilent ? undefined : normalizedText || undefined,
      audioAsVoice: Boolean(payload.audioAsVoice),
      mediaUrl: payload.mediaUrl ?? payload.mediaUrls?.[0],
      replyToId:
        payload.replyToId ?? (implicitCurrentMessageAllowed ? params.currentMessageId : undefined),
    });

    // Let through payloads with audioAsVoice flag even if empty (need to track it).
    if (!isRenderablePayload(normalizedPayload) && !payload.audioAsVoice) {
      return;
    }

    const mediaNormalizedPayload = params.normalizeMediaPaths
      ? await params.normalizeMediaPaths(normalizedPayload)
      : normalizedPayload;
    if (isSilent) {
      mediaNormalizedPayload.text = undefined;
    }
    const blockPayload = copyReplyPayloadMetadata(
      payload,
      params.applyReplyToMode(mediaNormalizedPayload),
    );
    if (blockPayload.text?.trim() !== payload.text?.trim()) {
      setReplyPayloadMetadata(blockPayload, { blockSourceText: undefined });
    }
    const blockHasNonTextContent = hasOutboundReplyContent({ ...blockPayload, text: undefined });

    // Skip empty payloads unless they have audioAsVoice flag (need to track it).
    if (!blockPayload.text && !blockHasNonTextContent && !blockPayload.audioAsVoice) {
      return;
    }

    if (blockPayload.text) {
      void params.typingSignals.signalTextDelta(blockPayload.text).catch((err: unknown) => {
        logVerbose(`block reply typing signal failed: ${String(err)}`);
      });
    }

    // Use pipeline if available (block streaming enabled), otherwise send directly.
    if (params.blockStreamingEnabled && params.blockReplyPipeline) {
      params.blockReplyPipeline.enqueue(blockPayload);
    } else if (
      params.blockStreamingEnabled ||
      blockHasNonTextContent ||
      blockPayload.isReasoning === true ||
      blockPayload.isCommentary === true
    ) {
      // Enabled display lanes never merge into final text, so deliver them directly
      // even when block streaming is off.
      await sendDirectBlockReply({
        onBlockReply: params.onBlockReply,
        directlySentBlockKeys: params.directlySentBlockKeys,
        directBlockDeliveries: params.directBlockDeliveries,
        payload: blockPayload,
      });
    }
    // When streaming is disabled entirely, text-only blocks are accumulated in final text.
  };
}
