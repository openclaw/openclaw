import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ContinuationAttemptFailureInput,
  ContinuationClaimResult,
  ContinuationCreateResult,
  ContinuationDeleteResult,
  ContinuationElection,
  ContinuationElectionResult,
  ContinuationNoticeSettlementInput,
  ContinuationNoticeSettlementResult,
  ContinuationPostCompactionReleaseInput,
  ContinuationPostCompactionReleaseResult,
  ContinuationPruneResult,
  ContinuationRecord,
  ContinuationRecordQuery,
  ContinuationRecordUpdate,
  ContinuationUpdateResult,
  NewContinuationRecord,
} from "./custody-store.types.js";

/** Shared-state worker operations owned by continuation custody (RFC §5.4.2). */
export type ContinuationCustodyWorkerOperations = {
  "continuationCustody.create": {
    input: { record: NewContinuationRecord };
    output: ContinuationCreateResult;
  };
  "continuationCustody.update": {
    input: { updates: ContinuationRecordUpdate[]; now: number };
    output: ContinuationUpdateResult;
  };
  "continuationCustody.elect": {
    input: ContinuationElection;
    output: ContinuationElectionResult;
  };
  "continuationCustody.claimSpawnAttempt": {
    input: { recordId: string; expectedRevision: number; now: number };
    output: ContinuationClaimResult;
  };
  "continuationCustody.recordSpawnAttemptFailure": {
    input: ContinuationAttemptFailureInput & { now: number };
    output: ContinuationUpdateResult;
  };
  "continuationCustody.delete": {
    input: { recordId: string; expectedRevision: number };
    output: ContinuationDeleteResult;
  };
  "continuationCustody.prune": {
    input: { endedBefore: number };
    output: ContinuationPruneResult;
  };
  "continuationCustody.settleNotice": {
    input: ContinuationNoticeSettlementInput;
    output: ContinuationNoticeSettlementResult;
  };
  "continuationCustody.releasePostCompaction": {
    input: ContinuationPostCompactionReleaseInput;
    output: ContinuationPostCompactionReleaseResult;
  };
  "continuationCustody.list": {
    input: ContinuationRecordQuery;
    output: ContinuationRecord[];
  };
  /** Phase A of custody readiness (§5.4.5): the live set, read in one transaction. */
  "continuationCustody.readBootFacts": {
    input: Record<string, never>;
    output: { live: ContinuationRecord[] };
  };
};

/**
 * A shared-state read, not a worker command: maintenance asks it before reading custody or rows
 * through the state worker, so a store with neither never starts that worker.
 */
export type ContinuationMaintenanceStateReadCommand = {
  type: "continuationCustody.maintenanceState";
};

export function isContinuationMaintenanceStateReadCommand(
  value: unknown,
): value is ContinuationMaintenanceStateReadCommand {
  return isRecord(value) && value.type === "continuationCustody.maintenanceState";
}
