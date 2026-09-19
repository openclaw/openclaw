import type {
  countFailedDeliveryQueueEntriesInDatabase,
  prepareDeliveryQueueTerminalEntry,
} from "./delivery-queue-sqlite.kernel.js";
import type { FailPendingDeliveryResult } from "./outbound/delivery-queue-settlement.types.js";

export type DeliveryQueueWorkerOperations = {
  "deliveryQueue.failPending": {
    input: {
      id: string;
      entryJson: string;
      expectedPlatformSendAttemptId?: string | null;
      retainSpoolArtifacts?: boolean;
      stateDir: string;
      prepared?: ReturnType<typeof prepareDeliveryQueueTerminalEntry>;
    };
    output: { result: FailPendingDeliveryResult; spoolPaths: string[] };
  };
  "deliveryQueue.countFailed": {
    input: undefined;
    output: ReturnType<typeof countFailedDeliveryQueueEntriesInDatabase>;
  };
};
