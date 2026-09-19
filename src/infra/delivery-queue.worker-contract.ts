import type { countFailedDeliveryQueueEntriesInDatabase } from "./delivery-queue-sqlite.kernel.js";
import type { loadDeliveryQueueMediaRetentionSnapshotInDatabase } from "./outbound/delivery-queue-media-staging.kernel.js";

export type DeliveryQueueWorkerOperations = {
  "deliveryQueue.countFailed": {
    input: undefined;
    output: ReturnType<typeof countFailedDeliveryQueueEntriesInDatabase>;
  };
  "deliveryQueue.pruneTombstones": { input: undefined; output: void };
  "deliveryQueue.mediaRetentionSnapshot": {
    input: Parameters<typeof loadDeliveryQueueMediaRetentionSnapshotInDatabase>[1];
    output: ReturnType<typeof loadDeliveryQueueMediaRetentionSnapshotInDatabase>;
  };
};
