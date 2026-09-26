import type { DurableDeliveryCompletion } from "../../infra/outbound/delivery-completion.js";
import { normalizeReplyPayloadsForDelivery } from "../../infra/outbound/payloads.js";
import {
  isMessagePresentationInteractiveBlock,
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
} from "../../interactive/payload.js";
import { getReplyPayloadMetadata, type ReplyPayload } from "../reply-payload.js";
import { normalizeReplyPayload } from "./normalize-reply.js";
import { sanitizePendingFinalDeliveryText } from "./pending-final-delivery-state.js";

/** Normalize raw final payloads into the channel-agnostic sendable set recovery can mark. */
export function normalizePendingFinalDeliveryPayloads(
  payloads: readonly ReplyPayload[],
): ReplyPayload[] {
  return normalizeReplyPayloadsForDelivery(normalizePendingFinalRecoveryPayloads(payloads));
}

/** Normalize raw final payloads for durable recovery without stripping delivery directives. */
export function normalizePendingFinalRecoveryPayloads(
  payloads: readonly ReplyPayload[],
): ReplyPayload[] {
  return payloads.flatMap((payload) => {
    const normalized = normalizeReplyPayload(payload, { applyChannelTransforms: false });
    return normalized ? [normalized] : [];
  });
}

/** Build durable recovery text only for payload shapes this marker can replay without loss. */
export function buildRecoverablePendingFinalDeliveryText(
  payloads: readonly ReplyPayload[],
): string | undefined {
  const sendablePayloads: ReplyPayload[] = [];
  for (const payload of payloads) {
    if (payload.isReasoning === true) {
      continue;
    }
    const recoveryPayload =
      payload.replyToId && getReplyPayloadMetadata(payload)?.replyToIdExplicit !== true
        ? { ...payload, replyToId: undefined }
        : payload;
    const deliveryPayloads = normalizeReplyPayloadsForDelivery([recoveryPayload]);
    if (deliveryPayloads.length === 0) {
      continue;
    }
    const replayablePayload = downgradeRichTextOnlyForRecovery(recoveryPayload) ?? recoveryPayload;
    const replayableDeliveryPayloads =
      replayablePayload === recoveryPayload
        ? deliveryPayloads
        : normalizeReplyPayloadsForDelivery([replayablePayload]);
    if (replayableDeliveryPayloads.length === 0) {
      continue;
    }
    if (
      hasUnsupportedDurableRecoveryShape(replayablePayload) ||
      replayableDeliveryPayloads.some(hasUnrecoverableNormalizedDeliveryShape)
    ) {
      return undefined;
    }
    sendablePayloads.push(...replayableDeliveryPayloads);
  }
  if (
    sendablePayloads.length > 1 &&
    sendablePayloads.some((payload) => hasDurableMedia(payload) || hasMediaDirectiveText(payload))
  ) {
    return undefined;
  }

  const recoveryText: string[] = [];
  for (const payload of sendablePayloads) {
    const textAndMedia = [
      payload.text,
      ...(payload.mediaUrls ?? []).map((mediaUrl) => `MEDIA:${mediaUrl}`),
    ]
      .filter((value): value is string => Boolean(value?.trim()))
      .join("\n");
    if (textAndMedia) {
      recoveryText.push(textAndMedia);
    }
  }
  return sanitizePendingFinalDeliveryText(recoveryText.join("\n\n")) || undefined;
}

export function resolvePendingFinalDeliveryCompletion(
  payloads: readonly ReplyPayload[] | undefined,
): Extract<DurableDeliveryCompletion, { kind: "pending-final" }> | undefined {
  const metadata = payloads
    ?.map((payload) => getReplyPayloadMetadata(payload))
    .find((candidate) => candidate?.pendingFinalDeliveryCompletion);
  const completion = metadata?.pendingFinalDeliveryCompletion;
  return completion
    ? {
        kind: "pending-final",
        ...completion,
        ...(metadata.sessionWriterDeliveryAuthority
          ? { sessionWriterDeliveryAuthority: metadata.sessionWriterDeliveryAuthority }
          : {}),
      }
    : undefined;
}

/**
 * Downgrades rich-text-only payloads (visible formatting in `presentation`)
 * to plain text for durable recovery. Buttons/selects (`presentation`
 * interactive blocks, or the deprecated `interactive`), threads,
 * media, voice/video, and delivery directives stay unrecoverable: stripping
 * them would lose actions, not just formatting.
 *
 * A nonempty `text` field alone is not trusted to carry the presentation's
 * substance: when `presentationTextMode` is not `"fallback"` (the authored
 * complete plain rendering), the complete shared presentation fallback
 * (`renderMessagePresentationFallbackText` — titles, text/context blocks,
 * chart/table) is used, exactly as Telegram delivery does in
 * `extensions/telegram/src/interactive-fallback.ts`. This preserves the full
 * visible reply instead of silently dropping titles/text/context.
 */
function downgradeRichTextOnlyForRecovery(payload: ReplyPayload): ReplyPayload | undefined {
  const presentation = normalizeMessagePresentation(payload.presentation);
  if (presentation === undefined) {
    return undefined;
  }
  if (!payload.text?.trim()) {
    return undefined;
  }
  if (
    payload.sensitiveMedia === true ||
    payload.trustedLocalMedia === true ||
    payload.interactive !== undefined ||
    payload.btw !== undefined ||
    payload.delivery !== undefined ||
    payload.channelData !== undefined ||
    payload.location !== undefined ||
    payload.replyToId !== undefined ||
    payload.replyToTag === true ||
    payload.replyToCurrent === true ||
    payload.audioAsVoice === true ||
    payload.videoAsNote === true ||
    payload.spokenText !== undefined ||
    payload.ttsSupplement !== undefined ||
    hasDurableMedia(payload)
  ) {
    return undefined;
  }
  // Buttons and select menus live in `presentation` now; `interactive` is only
  // the deprecated representation. Replaying text:"Pick one" while dropping
  // its controls would present an incomplete reply as recovered.
  if (presentation.blocks.some(isMessagePresentationInteractiveBlock)) {
    return undefined;
  }
  const { presentation: _presentation, ...plainPayload } = payload;
  if (payload.presentationTextMode === "fallback") {
    return plainPayload;
  }
  const currentText = payload.text.trim();
  // Render presentation alone, then apply the same equality/suffix dedup
  // Telegram delivery uses in `canonicalizeTelegramPresentationPayload`:
  // an already-materialized fallback must not be appended again.
  const presentationFallback = renderMessagePresentationFallbackText({ presentation });
  const fallbackText = presentationFallback.trim();
  const completeFallback = !fallbackText
    ? currentText
    : currentText === fallbackText || currentText.endsWith(`\n\n${fallbackText}`)
      ? currentText
      : [currentText, fallbackText].join("\n\n");
  // A presentation text line shaped like a MEDIA: directive would become a
  // delivery instruction on replay. Recovery cannot preserve it literally,
  // so such payloads stay transport-only.
  if (/^\s*MEDIA:/im.test(presentationFallback)) {
    return undefined;
  }
  if (!completeFallback.trim()) {
    return plainPayload;
  }
  const { presentationTextMode: _presentationTextMode, ...strippedPayload } = plainPayload;
  return {
    ...strippedPayload,
    text: completeFallback,
  };
}

function hasUnsupportedDurableRecoveryShape(payload: ReplyPayload): boolean {
  const hasMedia = hasDurableMedia(payload);
  return (
    payload.sensitiveMedia === true ||
    payload.trustedLocalMedia === true ||
    payload.presentation !== undefined ||
    payload.interactive !== undefined ||
    payload.btw !== undefined ||
    payload.delivery !== undefined ||
    payload.channelData !== undefined ||
    payload.location !== undefined ||
    payload.replyToId !== undefined ||
    payload.replyToTag === true ||
    payload.replyToCurrent === true ||
    payload.audioAsVoice === true ||
    payload.videoAsNote === true ||
    payload.spokenText !== undefined ||
    payload.ttsSupplement !== undefined ||
    (hasMedia && (payload.isCommentary === true || payload.isStatusNotice === true))
  );
}

function hasDurableMedia(payload: ReplyPayload): boolean {
  return Boolean(payload.mediaUrl?.trim() || payload.mediaUrls?.some((url) => url.trim()));
}

function hasMediaDirectiveText(payload: ReplyPayload): boolean {
  return /^\s*MEDIA:/imu.test(payload.text ?? "");
}

function hasUnrecoverableNormalizedDeliveryShape(payload: ReplyPayload): boolean {
  return (
    payload.replyToCurrent === true ||
    payload.replyToTag === true ||
    payload.replyToId !== undefined ||
    payload.audioAsVoice === true ||
    payload.videoAsNote === true
  );
}
