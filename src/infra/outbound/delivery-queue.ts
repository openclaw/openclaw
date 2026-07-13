// Public outbound delivery queue facade for storage and recovery operations.
export {
  ackDelivery,
  enqueueDelivery,
  failDelivery,
  failDeliveryAfterPlatformSend,
  failDeliveryBeforePlatformSend,
  failPendingDelivery,
  loadPendingDelivery,
  loadPendingDeliveries,
  markDeliveryPlatformOutcomeUnknown,
  markDeliveryPlatformSendDispatched,
  markDeliveryPlatformSendAttemptStarted,
  moveToFailed,
} from "./delivery-queue-storage.js";
export type {
  QueuedReplyPayloadSendingHook,
  QueuedRenderedMessageBatchPlan,
} from "./delivery-queue-storage.js";
export {
  computeBackoffMs,
  drainPendingDeliveries,
  isEntryEligibleForRecoveryRetry,
  isPermanentDeliveryError,
  MAX_RETRIES,
  recoverPendingDeliveries,
  withActiveDeliveryClaim,
} from "./delivery-queue-recovery.js";
export type { DeliverFn, RecoveryLogger } from "./delivery-queue-recovery.js";
