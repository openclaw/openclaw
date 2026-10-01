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
    LEGACY_SESSION_ENTRY_STATE_FIELDS.some((field) => Object.hasOwn(value, field))
  );
}
