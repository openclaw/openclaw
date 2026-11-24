import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { resolveDeliveryQueueAttemptCount } from "../delivery-queue-sqlite.types.js";
import {
  FINAL_TEXT_RECOVERY_MAX_ATTEMPTS,
  hasActiveDeliveryOwner,
  type QueuedDelivery,
} from "./delivery-queue-types.js";

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

/**
 * The one rule for unconfirmed sends no adapter can reconcile: an ordinary agent final text is
 * resent once, accepting a rare duplicate over a lost reply. A crash mid-send leaves
 * `send_attempt_started`; a live ambiguous transport failure is typed. Other post-send evidence
 * (accepted chunks, untyped failures) never qualifies, and an adapter's `not_sent` verdict keeps
 * its own replay rule.
 */
export function canReplayAmbiguousFinalText(
  entry: QueuedDelivery,
  reconciliation?: { status: string } | null,
): boolean {
  return (
    entry.retryAmbiguousFinalText === true &&
    reconciliation?.status !== "not_sent" &&
    (entry.ambiguousTransportError === true || entry.recoveryState === "send_attempt_started") &&
    resolveDeliveryQueueAttemptCount(entry) <
      Math.min(FINAL_TEXT_RECOVERY_MAX_ATTEMPTS, resolveMaxRetries(entry))
  );
}

/** "proven": the adapter proved a started send never left; "blind": the final-text rule above. */
export type UnknownSendReplay = "blind" | "proven";

export function resolveUnknownSendReplay(
  entry: QueuedDelivery,
  reconciliation?: { status: string } | null,
): UnknownSendReplay | undefined {
  if (reconciliation?.status === "not_sent" && entry.recoveryState === "send_attempt_started") {
    return "proven";
  }
  return canReplayAmbiguousFinalText(entry, reconciliation) ? "blind" : undefined;
}

export function shouldInspectQueuedDelivery(entry: QueuedDelivery, now: number): boolean {
  // The live producer may still be awaiting its committed enqueue reply. Taking
  // an inspection claim would preempt it before we reload and skip its lease.
  return Boolean(entry.settlement) || !hasActiveDeliveryOwner(entry, now);
}

/** Resolves the platform attempt identity a recovered delivery must reconcile against. */
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
