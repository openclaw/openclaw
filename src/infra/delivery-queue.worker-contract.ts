import type { countFailedDeliveryQueueEntriesInDatabase } from "./delivery-queue-sqlite.kernel.js";
import type { AckDeliveryOptions } from "./outbound/delivery-queue-settlement.types.js";

export type DeliveryQueueWorkerOperations = {
  "deliveryQueue.ack": {
    input: { id: string; stateDir: string; options?: AckDeliveryOptions };
    output: string[];
  };
  "deliveryQueue.countFailed": {
    input: undefined;
    output: ReturnType<typeof countFailedDeliveryQueueEntriesInDatabase>;
  };
};
