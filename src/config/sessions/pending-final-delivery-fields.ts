import type { SessionEntry } from "./types.js";

export type PendingFinalDeliveryFields = Pick<
  SessionEntry,
  | "pendingFinalDelivery"
  | "pendingFinalDeliveryText"
  | "pendingFinalDeliveryCreatedAt"
  | "pendingFinalDeliveryLastAttemptAt"
  | "pendingFinalDeliveryAttemptCount"
  | "pendingFinalDeliveryLastError"
  | "pendingFinalDeliveryContext"
  | "pendingFinalDeliveryIntentId"
>;

export const FRESH_PENDING_FINAL_DELIVERY_RETRY_FIELDS = {
  pendingFinalDeliveryLastAttemptAt: undefined,
  pendingFinalDeliveryAttemptCount: undefined,
  pendingFinalDeliveryLastError: undefined,
  pendingFinalDeliveryContext: undefined,
  pendingFinalDeliveryIntentId: undefined,
} satisfies Partial<PendingFinalDeliveryFields>;

export const CLEARED_PENDING_FINAL_DELIVERY_FIELDS = {
  pendingFinalDelivery: undefined,
  pendingFinalDeliveryText: undefined,
  pendingFinalDeliveryCreatedAt: undefined,
  pendingFinalDeliveryLastAttemptAt: undefined,
  pendingFinalDeliveryAttemptCount: undefined,
  pendingFinalDeliveryLastError: undefined,
  pendingFinalDeliveryContext: undefined,
  pendingFinalDeliveryIntentId: undefined,
} satisfies PendingFinalDeliveryFields;

export function pickPendingFinalDeliveryFields(
  entry: SessionEntry | undefined,
): PendingFinalDeliveryFields {
  return {
    pendingFinalDelivery: entry?.pendingFinalDelivery,
    pendingFinalDeliveryText: entry?.pendingFinalDeliveryText,
    pendingFinalDeliveryCreatedAt: entry?.pendingFinalDeliveryCreatedAt,
    pendingFinalDeliveryLastAttemptAt: entry?.pendingFinalDeliveryLastAttemptAt,
    pendingFinalDeliveryAttemptCount: entry?.pendingFinalDeliveryAttemptCount,
    pendingFinalDeliveryLastError: entry?.pendingFinalDeliveryLastError,
    pendingFinalDeliveryContext: entry?.pendingFinalDeliveryContext,
    pendingFinalDeliveryIntentId: entry?.pendingFinalDeliveryIntentId,
  };
}

function stableJson(value: unknown): string | undefined {
  return value === undefined ? undefined : JSON.stringify(value);
}

export function samePendingFinalDeliveryFields(
  left: PendingFinalDeliveryFields,
  right: PendingFinalDeliveryFields,
): boolean {
  return (
    Object.is(left.pendingFinalDelivery, right.pendingFinalDelivery) &&
    Object.is(left.pendingFinalDeliveryText, right.pendingFinalDeliveryText) &&
    Object.is(left.pendingFinalDeliveryCreatedAt, right.pendingFinalDeliveryCreatedAt) &&
    Object.is(left.pendingFinalDeliveryLastAttemptAt, right.pendingFinalDeliveryLastAttemptAt) &&
    Object.is(left.pendingFinalDeliveryAttemptCount, right.pendingFinalDeliveryAttemptCount) &&
    Object.is(left.pendingFinalDeliveryLastError, right.pendingFinalDeliveryLastError) &&
    stableJson(left.pendingFinalDeliveryContext) ===
      stableJson(right.pendingFinalDeliveryContext) &&
    Object.is(left.pendingFinalDeliveryIntentId, right.pendingFinalDeliveryIntentId)
  );
}

export function preserveChangedPendingFinalDeliveryFields(params: {
  next: SessionEntry;
  loaded: SessionEntry | undefined;
  current: SessionEntry | undefined;
}): SessionEntry {
  if (!params.loaded || !params.current || params.current.sessionId !== params.loaded.sessionId) {
    return params.next;
  }
  const loadedFields = pickPendingFinalDeliveryFields(params.loaded);
  const currentFields = pickPendingFinalDeliveryFields(params.current);
  if (samePendingFinalDeliveryFields(loadedFields, currentFields)) {
    return params.next;
  }
  return {
    ...params.next,
    ...currentFields,
  };
}
