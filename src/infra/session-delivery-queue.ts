// Public session delivery queue facade: storage and recovery live in split
// modules, callers import the stable aggregate API from here.
export {
  ackSessionDelivery,
  buildPostCompactionDelegateDeliveryPayload,
  DEFAULT_FAILED_MAX_AGE_MS,
  enqueuePostCompactionDelegateDelivery,
  enqueueSessionDelivery,
  failSessionDelivery,
  loadPendingSessionDelivery,
  loadPendingSessionDeliveries,
  moveSessionDeliveryToFailed,
  pruneFailedOlderThan,
} from "./session-delivery-queue-storage.js";
export type {
  QueuedSessionDelivery,
  QueuedSessionDeliveryPayload,
  SessionDeliveryContext,
  SessionDeliveryRoute,
} from "./session-delivery-queue-storage.js";
export {
  drainPendingSessionDeliveries,
  isSessionDeliveryEligibleForRetry,
  MAX_SESSION_DELIVERY_RETRIES,
  recoverPendingSessionDeliveries,
} from "./session-delivery-queue-recovery.js";
export type {
  DeliverSessionDeliveryFn,
  PendingSessionDeliveryDrainDecision,
  SessionDeliveryRecoveryLogger,
  SessionDeliveryRecoverySummary,
} from "./session-delivery-queue-recovery.js";
