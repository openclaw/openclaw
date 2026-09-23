import type { DurableDeliveryCompletion } from "../../infra/outbound/delivery-completion.js";
import { normalizeReplyPayloadsForDelivery } from "../../infra/outbound/payloads.js";
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
    if (
      hasUnsupportedDurableRecoveryShape(recoveryPayload) ||
      deliveryPayloads.some(hasUnrecoverableNormalizedDeliveryShape)
    ) {
      return undefined;
    }
    sendablePayloads.push(...deliveryPayloads);
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
