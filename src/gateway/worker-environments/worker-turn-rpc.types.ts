import type { WorkerSessionTurnClaim } from "./placement-record.js";
import type { WorkerGatewayToolRuntime } from "./worker-gateway-tool-contract.js";

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
  | { kind: "inference" }
  | { kind: "live"; seq: number }
  | { kind: "transcript"; seq: number }
  | { kind: "session-tool" }
  | { kind: "tool-surface"; surface: WorkerGatewayToolRuntime | undefined };

export type WorkerPlacementValidation = "sessionless" | "durable" | "invalid";
