import type { OpenClawStateWorkerErrorPayload } from "../state/openclaw-state-worker-error.js";
import type {
  claimDeliveryQueueEntryPlatformSendInDatabase,
  renewDeliveryQueueEntryPlatformSendLeaseInDatabase,
} from "./delivery-queue-sqlite-claim.kernel.js";
import type {
  countFailedDeliveryQueueEntriesInDatabase,
  prepareDeliveryQueueTerminalEntry,
} from "./delivery-queue-sqlite.kernel.js";
import type { loadDeliveryQueueMediaRetentionSnapshotInDatabase } from "./outbound/delivery-queue-media-staging.kernel.js";
import type {
  AckDeliveryOptions,
  FailPendingDeliveryResult,
} from "./outbound/delivery-queue-settlement.types.js";

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
  "deliveryQueue.ack": {
    input: { id: string; stateDir: string; options?: AckDeliveryOptions };
    output: string[];
  };
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
  "deliveryQueue.pruneTombstones": { input: undefined; output: void };
  "deliveryQueue.mediaRetentionSnapshot": {
    input: Parameters<typeof loadDeliveryQueueMediaRetentionSnapshotInDatabase>[1];
    output: ReturnType<typeof loadDeliveryQueueMediaRetentionSnapshotInDatabase>;
  };
};
