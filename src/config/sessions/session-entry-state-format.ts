import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionDeliveryState } from "./types.js";

export function isCanonicalSessionDeliveryState(value: unknown): value is SessionDeliveryState {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === "none" || value.kind === "internal") {
    return true;
  }
  return (
    value.kind === "external" &&
    Boolean(value.route && typeof value.route === "object") &&
    Boolean(value.context && typeof value.context === "object") &&
    Boolean(value.origin && typeof value.origin === "object")
  );
}

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
    ("status" in value && (value.status === "running" || value.status === "queued")) ||
    ("pendingFinalDelivery" in value && typeof value.pendingFinalDelivery === "boolean") ||
    hasLegacySessionProviderState(value) ||
    LEGACY_SESSION_ENTRY_STATE_FIELDS.some((field) => Object.hasOwn(value, field))
  );
}
