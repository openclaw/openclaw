import type { ReserveDeliveryQueueAttemptResult } from "../delivery-queue-sqlite.kernel.js";
import type {
  OutboundDeliverySnapshot,
  StableDeliveryPreparation,
} from "./delivery-queue-storage.types.js";

export type OutboundDeliveryMutation = {
  id: string;
  expectedPlatformSendAttemptId?: string | null;
} & (
  | { kind: "fail" | "fail-before-send" | "fail-after-send"; error: string }
  | { kind: "start" | "dispatch"; route?: { replyToId?: string | null } }
  | { kind: "unknown" }
);

export type OutboundDeliveryStorageOperations = {
  "deliveryQueue.claimPreparation": {
    input: { id: string };
    output: { status: "claimed"; entry: StableDeliveryPreparation } | { status: "existing" };
  };
  "deliveryQueue.replacePreparation": {
    input: {
      expectedEntry: StableDeliveryPreparation;
      replacementEntry: StableDeliveryPreparation;
    };
    output: boolean;
  };
  "deliveryQueue.completePreparation": {
    input: { expectedEntry: StableDeliveryPreparation };
    output: boolean;
  };
  "deliveryQueue.failPreparation": { input: { entry: StableDeliveryPreparation }; output: void };

  "deliveryQueue.mutateOutbound": { input: OutboundDeliveryMutation; output: void };
  "deliveryQueue.reserveOutbound": {
    input: { id: string; maxAttempts: number; expectedPlatformSendAttemptId?: string };
    output: ReserveDeliveryQueueAttemptResult;
  };
  "deliveryQueue.restoreOutbound": {
    input: {
      entry: OutboundDeliverySnapshot;
      reservedAttemptCount: number;
      claimedAttemptId?: string;
    };
    output: void;
  };
  "deliveryQueue.stageFailure": {
    input: {
      entry: OutboundDeliverySnapshot;
      settlementEntry: OutboundDeliverySnapshot;
      claimedAttemptId?: string;
    };
    output: OutboundDeliverySnapshot | undefined;
  };
  "deliveryQueue.finalizeFailure": { input: { entry: OutboundDeliverySnapshot }; output: boolean };
  "deliveryQueue.retireUnsent": {
    input: { id: string; producerClaimId: string; stateDir?: string; terminalOutcome?: "failed" };
    output: { spoolPaths: string[]; retention?: string } | undefined;
  };
};
