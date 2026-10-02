import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isCanonicalSessionDeliveryState } from "../../utils/delivery-context.shared.js";

export const LEGACY_SESSION_PROVIDER_FIELDS = [
  ["provider", "channel"],
  ["lastProvider", "lastChannel"],
] as const;

export function hasLegacySessionProviderState(value: object): boolean {
  return (
    isRecord(value) &&
    !isCanonicalSessionDeliveryState(value.delivery) &&
    LEGACY_SESSION_PROVIDER_FIELDS.some(
      ([legacy, current]) =>
        typeof value[legacy] === "string" && typeof value[current] !== "string",
    )
  );
}

export const LEGACY_SESSION_ENTRY_STATE_FIELDS = [
  "pendingFinalDeliveryCreatedAt",
  "pendingFinalDeliveryLastAttemptAt",
  "pendingFinalDeliveryAttemptCount",
  "pendingFinalDeliveryLastError",
  "pendingFinalDeliveryText",
  "pendingFinalDeliveryContext",
  "pendingFinalDeliveryIntentId",
  "fallbackNoticeSelectedModel",
  "fallbackNoticeActiveModel",
  "fallbackNoticeReason",
  "memoryFlushAt",
  "memoryFlushCompactionCount",
  "memoryFlushContextHash",
  "memoryFlushFailureCount",
  "memoryFlushLastFailedAt",
  "memoryFlushLastFailureError",
] as const;

/** Detection grants no read-through compatibility; Doctor owns the conversion. */
export function hasLegacySessionEntryState(value: object): boolean {
  return (
    ("pendingFinalDelivery" in value && typeof value.pendingFinalDelivery === "boolean") ||
    hasLegacySessionProviderState(value) ||
    LEGACY_SESSION_ENTRY_STATE_FIELDS.some((field) => Object.hasOwn(value, field))
  );
}
