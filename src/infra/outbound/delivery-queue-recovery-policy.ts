import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { QueuedDelivery } from "./delivery-queue-types.js";

const DEFAULT_MAX_RETRIES = 5;
const TEXT_FINAL_FIELDS: Record<string, true> = {
  text: true,
  replyToId: true,
  replyToTag: true,
  replyToCurrent: true,
};

export function isOrdinaryFinalText(
  payloads: readonly ReplyPayload[],
  isTextOnlyChannelData?: (channelData: NonNullable<ReplyPayload["channelData"]>) => boolean,
): boolean {
  const payload = payloads[0];
  return (
    payloads.length === 1 &&
    payload !== undefined &&
    Boolean(payload.text?.trim()) &&
    Object.entries(payload).every(
      ([field, value]) =>
        value === undefined ||
        Object.hasOwn(TEXT_FINAL_FIELDS, field) ||
        (field === "channelData" &&
          payload.channelData !== undefined &&
          isTextOnlyChannelData?.(payload.channelData) === true),
    )
  );
}

export function canReplayAmbiguousFinalText(entry: QueuedDelivery): boolean {
  return entry.retryAmbiguousFinalText === true && entry.ambiguousTransportError === true;
}

const PERMANENT_ERROR_PATTERNS: readonly RegExp[] = [
  /no conversation reference found/i,
  /chat not found/i,
  /user not found/i,
  /bot.*not.*member/i,
  /bot was blocked by the user/i,
  /forbidden: bot was kicked/i,
  /chat_id is empty/i,
  /recipient is not a valid/i,
  /ambiguous .* recipient/i,
  /User .* not in room/i,
];

export function resolveMaxRetries(entry: QueuedDelivery): number {
  const configured = entry.maxRetries;
  return typeof configured === "number" && Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_RETRIES;
}

export function isPermanentDeliveryError(error: string): boolean {
  return PERMANENT_ERROR_PATTERNS.some((re) => re.test(error));
}

export function recoveryPlatformAttemptId(entry: QueuedDelivery, claimedAttemptId?: string) {
  return claimedAttemptId !== undefined
    ? claimedAttemptId
    : typeof entry.platformSendAttemptId === "string"
      ? entry.platformSendAttemptId
      : entry.recoveryState === "producer_claimed" && typeof entry.producerClaimId === "string"
        ? entry.producerClaimId
        : typeof entry.completionRetention === "object" || entry.requiresProducerClaim === true
          ? null
          : undefined;
}
