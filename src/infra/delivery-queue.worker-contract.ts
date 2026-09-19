import type {
  claimDeliveryQueueEntryPlatformSendInDatabase,
  renewDeliveryQueueEntryPlatformSendLeaseInDatabase,
} from "./delivery-queue-sqlite-claim.kernel.js";
import type { countFailedDeliveryQueueEntriesInDatabase } from "./delivery-queue-sqlite.kernel.js";

export type DeliveryQueueWorkerOperations = {
  "deliveryQueue.claimPlatformSend": {
    input: Parameters<typeof claimDeliveryQueueEntryPlatformSendInDatabase>[1] & {
      claimId: string;
    };
    output: ReturnType<typeof claimDeliveryQueueEntryPlatformSendInDatabase>;
  };
  "deliveryQueue.renewPlatformSendLease": {
    input: Parameters<typeof renewDeliveryQueueEntryPlatformSendLeaseInDatabase>[1];
    output: ReturnType<typeof renewDeliveryQueueEntryPlatformSendLeaseInDatabase>;
  };
  "deliveryQueue.countFailed": {
    input: undefined;
    output: ReturnType<typeof countFailedDeliveryQueueEntriesInDatabase>;
  };
};
