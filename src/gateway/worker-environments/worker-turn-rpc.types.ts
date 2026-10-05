import type { WorkerProtocolCloseReason } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import type { createWorkerInferenceManager } from "./inference.js";
import type { WorkerLiveEventReceiver, WorkerLiveEventApplicationResult } from "./live-events.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import type { WorkerSessionPlacementGate } from "./placement-worker-gate.js";
import type { WorkerEnvironmentStore } from "./store.js";
import type { WorkerTranscriptCommitOutcome } from "./transcript-commit-ledger.js";
import type { WorkerTranscriptCommitApplication } from "./transcript-commit.js";
import type { WorkerGatewayToolRuntime } from "./worker-gateway-tool-contract.js";
import type { WorkerComputerExecutor } from "./worker-turn-computer-rpc.js";

export type WorkerProcessTurnBinding = {
  turnClaim: WorkerSessionTurnClaim;
  credentialHash: string;
};

export type WorkerTerminalTurnFence = WorkerProcessTurnBinding & {
  transcriptSeq: number;
  liveSeq: number;
};

export type WorkerPendingTerminalTurnFence = WorkerProcessTurnBinding & {
  terminalLiveSeq: number;
};

export type WorkerTurnRequest =
  | { kind: "heartbeat" }
  | { kind: "inference" }
  | { kind: "live"; seq: number }
  | { kind: "transcript"; seq: number }
  | { kind: "session-tool" }
  | { kind: "tool-surface"; surface: WorkerGatewayToolRuntime | undefined };

export type WorkerPlacementValidation = "sessionless" | "durable" | "invalid";

export type WorkerTranscriptCommitServiceResult =
  | WorkerTranscriptCommitOutcome
  | { ok: false; closeReason: WorkerProtocolCloseReason };

export type WorkerLiveEventServiceResult =
  | WorkerLiveEventApplicationResult
  | { ok: false; closeReason: WorkerProtocolCloseReason };

export type WorkerInferenceServiceResult<K extends "start" | "cancel"> =
  | Awaited<ReturnType<ReturnType<typeof createWorkerInferenceManager>[K]>>
  | { ok: false; closeReason: WorkerProtocolCloseReason };

export type WorkerTurnRpcOptions = {
  store: WorkerEnvironmentStore;
  prepareInstallation: (
    install: WorkerInstallationArtifact["install"],
  ) => Promise<WorkerInstallationArtifact>;
  applyTranscriptCommit?: WorkerTranscriptCommitApplication;
  liveEvents?: Pick<WorkerLiveEventReceiver, "apply">;
  placementStore?: WorkerSessionPlacementGate;
  executeComputer?: WorkerComputerExecutor;
  inference: ReturnType<typeof createWorkerInferenceManager>;
  isStopping: () => boolean;
  now: () => number;
  withLock: <T>(environmentId: string, task: () => Promise<T>) => Promise<T>;
};
