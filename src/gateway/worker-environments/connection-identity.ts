import type {
  WorkerInferenceEventParams,
  WorkerInferenceStartParams,
  WorkerInferenceTerminalOutcome,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";

/** Hash-only worker identity retained after admission. */
export type WorkerConnectionIdentity = {
  environmentId: string;
  credentialHash: string;
  bundleHash: string;
  sessionId: string | null;
  runId: string | null;
  turnClaim: WorkerSessionTurnClaim | null;
  ownerEpoch: number;
  rpcSetVersion: number;
  protocolFeatures: string[];
  credentialExpiresAtMs: number;
};

export type WorkerInferenceExecutor = (params: {
  identity: WorkerConnectionIdentity;
  request: WorkerInferenceStartParams;
  signal: AbortSignal;
  emit: (event: WorkerInferenceEventParams["event"]) => void;
  isCurrent(): boolean;
  sessionTarget: BoundAgentRunSessionTarget;
}) => Promise<WorkerInferenceTerminalOutcome>;
