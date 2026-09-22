import type { countFailedDeliveryQueueEntriesInDatabase } from "./delivery-queue-sqlite.kernel.js";

export type DeliveryQueueWorkerOperations = {
  "deliveryQueue.countFailed": {
    input: undefined;
    output: ReturnType<typeof countFailedDeliveryQueueEntriesInDatabase>;
  };
};
