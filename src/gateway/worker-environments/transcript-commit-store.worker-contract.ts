import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  WorkerTranscriptCommitErrorReason,
  WorkerTranscriptCommitResult,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
export type WorkerTranscriptCommitOperations = {
  "placementTranscript.begin": {
    input: WorkerTranscriptCommitInput & { nowMs: number };
    output: WorkerTranscriptCommitBeginResult;
  };
  "placementTranscript.complete": {
    input: WorkerTranscriptCommitInput & { outcome: WorkerTranscriptCommitOutcome; nowMs: number };
    output: WorkerTranscriptCommitOutcome;
  };
  "placementTranscript.discard": {
    input: WorkerTranscriptCommitInput & { nowMs: number };
    output: true;
  };
};

export type WorkerTranscriptCommitInput = {
  environmentId: string;
  sessionId: string;
  runEpoch: number;
  seq: number;
  requestHash: string;
};

export type WorkerTranscriptCommitOutcome =
  | { ok: true; result: WorkerTranscriptCommitResult }
  | { ok: false; reason: WorkerTranscriptCommitErrorReason };

export type WorkerTranscriptCommitBeginResult =
  | { kind: "claimed" }
  | { kind: "recover" }
  | { kind: "replay"; outcome: WorkerTranscriptCommitOutcome }
  | { kind: "rejected"; reason: "conflict" }
  | { kind: "rejected"; reason: "out-of-order"; expectedSeq: number };

function isCommitResult(value: unknown): value is WorkerTranscriptCommitResult {
  return (
    isRecord(value) &&
    Array.isArray(value.entryIds) &&
    value.entryIds.length > 0 &&
    value.entryIds.every((entry: unknown) => typeof entry === "string" && entry.length > 0) &&
    typeof value.newLeafId === "string" &&
    value.newLeafId.length > 0
  );
}

function isCommitErrorReason(value: unknown): value is WorkerTranscriptCommitErrorReason {
  return (
    value === "stale-base-leaf" ||
    value === "epoch-mismatch" ||
    value === "invalid-batch" ||
    value === "session-not-attached"
  );
}

export function isWorkerTranscriptCommitOutcome(
  value: unknown,
): value is WorkerTranscriptCommitOutcome {
  return (
    isRecord(value) &&
    ((value.ok === true && isCommitResult(value.result)) ||
      (value.ok === false && isCommitErrorReason(value.reason)))
  );
}

export function isWorkerTranscriptCommitBeginResult(
  value: unknown,
): value is WorkerTranscriptCommitBeginResult {
  return (
    isRecord(value) &&
    (value.kind === "claimed" ||
      value.kind === "recover" ||
      (value.kind === "replay" && isWorkerTranscriptCommitOutcome(value.outcome)) ||
      (value.kind === "rejected" &&
        (value.reason === "conflict" ||
          (value.reason === "out-of-order" &&
            typeof value.expectedSeq === "number" &&
            Number.isSafeInteger(value.expectedSeq) &&
            value.expectedSeq > 0))))
  );
}
