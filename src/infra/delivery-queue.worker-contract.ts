import type { OpenClawStateWorkerErrorPayload } from "../state/openclaw-state-worker-error.js";
import type { countFailedDeliveryQueueEntriesInDatabase } from "./delivery-queue-sqlite.kernel.js";

export type DeliveryQueueWorkerOperations = {
  "deliveryQueue.enqueue": {
    input: { entryJson: string; mediaStageId?: string } & (
      | { kind: "random" | "stable" }
      | { kind: "prepared"; preparationJson: string }
    );
    output:
      | "created"
      | "existing"
      | "missing"
      | "moved"
      | "source-changed"
      | "destination-exists"
      | "staging-missing"
      | { status: "not-published"; error: OpenClawStateWorkerErrorPayload };
  };
  "deliveryQueue.countFailed": {
    input: undefined;
    output: ReturnType<typeof countFailedDeliveryQueueEntriesInDatabase>;
  };
};
