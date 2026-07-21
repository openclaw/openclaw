// Public outbound delivery queue facade for storage and recovery operations.
export {
  ackDelivery,
  clearDeliveryMessageSentProviderAttempts,
  enqueueDelivery,
  enqueueDeliveryOnce,
  failDelivery,
  failDeliveryAfterPlatformSend,
  failDeliveryBeforePlatformSend,
  markDeliveryPlatformOutcomeUnknown,
  markDeliveryMessageSentProviderAttempted,
  recordDeliveryMessageSentHookEvent,
  markDeliveryPlatformSendDispatched,
  markDeliveryPlatformSendAttemptStarted,
} from "./delivery-queue-storage.js";
export type {
  QueuedPreDeliveryPayloadOutcome,
  QueuedReplyPayloadSendingHook,
  QueuedRenderedMessageBatchPlan,
} from "./delivery-queue-storage.js";
export {
  drainPendingDeliveries,
  recoverPendingDeliveries,
  withActiveDeliveryClaim,
} from "./delivery-queue-recovery.js";
export type { DeliverFn, RecoveryLogger } from "./delivery-queue-recovery.js";
