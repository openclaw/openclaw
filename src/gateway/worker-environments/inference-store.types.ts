import type { WorkerInferenceTerminalOutcome } from "../../../packages/gateway-protocol/src/schema/worker-inference.js";

export type WorkerInferenceTurnInput = {
  environmentId: string;
  sessionId: string;
  runEpoch: number;
  runId: string;
  turnId: string;
  requestHash: string;
};

export type WorkerInferenceTurnBeginResult =
  | { kind: "claimed" }
  | { kind: "recover" }
  | { kind: "replay"; outcome: WorkerInferenceTerminalOutcome }
  | { kind: "rejected"; reason: "conflict" };

export type WorkerInferenceRetentionPolicy = {
  maxAgeMs: number;
  maxRows: number;
  maxBytes: number;
};
