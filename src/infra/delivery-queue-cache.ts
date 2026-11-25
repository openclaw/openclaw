import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners } from "../shared/listeners.js";
import type { SqliteDatabaseAdmissionKey } from "./sqlite-database-admission.js";

export const outboundDeliveryNotifications = resolveGlobalSingleton(
  Symbol.for("openclaw.outboundDeliveryEnqueued"),
  () => ({ onEnqueued: (_stateDir: string) => {} }),
);
export const notifyOutboundDeliveryEnqueued = (stateDir: string) =>
  notifyListeners([outboundDeliveryNotifications.onEnqueued], stateDir);

export const emptyOutboundDeliveryQueueAdmission: SqliteDatabaseAdmissionKey<true | undefined> = {
  name: "state.empty-outbound-delivery-queue",
  read: (value) => (value === true ? true : undefined),
};

export type FailedDeliveryQueueHealth = Array<{
  queueName: string;
  count: number;
  oldestFailedAt?: number;
}>;

export const failedDeliveryQueueHealthAdmission: SqliteDatabaseAdmissionKey<
  FailedDeliveryQueueHealth | undefined
> = {
  name: "state.failed-delivery-queue-health",
  // SAFETY: Only the delivery queue owner publishes this typed diagnostic projection.
  read: (value) => value as FailedDeliveryQueueHealth | undefined,
};

export const oldestDeliveryQueueMediaStageAdmission: SqliteDatabaseAdmissionKey<
  number | null | undefined
> = {
  name: "state.oldest-delivery-queue-media-stage",
  read: (value) => (value === null || typeof value === "number" ? value : undefined),
};

type DeliveryQueueTombstoneExpiry = { enqueuedAt: number; maxAgeMs: number } | null;

export const nextDeliveryQueueTombstoneExpiryAdmission: SqliteDatabaseAdmissionKey<
  DeliveryQueueTombstoneExpiry | undefined
> = {
  name: "state.next-delivery-queue-tombstone-expiry",
  // SAFETY: Only the delivery queue owner publishes this typed retention projection.
  read: (value) => value as DeliveryQueueTombstoneExpiry | undefined,
};

export function isDeliveryQueueTombstonePruneDue(
  expiry: DeliveryQueueTombstoneExpiry | undefined,
  now: number,
): boolean {
  return expiry === undefined || (expiry !== null && expiry.enqueuedAt < now - expiry.maxAgeMs);
}
