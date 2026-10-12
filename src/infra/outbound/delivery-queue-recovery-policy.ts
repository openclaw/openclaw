import type { DeliveryRecoveryDrainDecision } from "../delivery-recovery.shared.js";
import { hasActiveDeliveryOwner, type QueuedDelivery } from "./delivery-queue-types.js";

const DEFAULT_MAX_RETRIES = 5;

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

export function resolveAttemptCount(entry: QueuedDelivery): number {
  const persisted = entry.attemptCount;
  const attemptCount =
    typeof persisted === "number" && Number.isInteger(persisted) && persisted >= 0 ? persisted : 0;
  return Math.max(attemptCount, entry.retryCount);
}

export function isPermanentDeliveryError(error: string): boolean {
  return PERMANENT_ERROR_PATTERNS.some((re) => re.test(error));
}
