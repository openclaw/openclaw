import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { DeliveryRecoveryDrainDecision } from "../delivery-recovery.shared.js";
import { hasActiveDeliveryOwner, type QueuedDelivery } from "./delivery-queue-types.js";

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

export function shouldInspectQueuedDelivery(
  entry: QueuedDelivery,
  now: number,
  selectEntry?: (entry: QueuedDelivery, now: number) => DeliveryRecoveryDrainDecision,
): boolean {
  // The live producer may still be awaiting its committed enqueue reply. Taking
  // an inspection claim would preempt it before we reload and skip its lease.
  return (
    Boolean(entry.settlement) ||
    (!hasActiveDeliveryOwner(entry, now) &&
      (selectEntry === undefined || selectEntry(entry, now).match))
  );
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
