import type { QueuedDelivery } from "./delivery-queue-types.js";

export function needsUnknownSendReconciliation(entry: QueuedDelivery): boolean {
  return (
    entry.recoveryState === "send_attempt_started" || entry.recoveryState === "unknown_after_send"
  );
}
