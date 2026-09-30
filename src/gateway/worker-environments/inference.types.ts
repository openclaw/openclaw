import type {
  WorkerInferenceCancelResult,
  WorkerInferenceErrorReason,
  WorkerInferenceEventFrame,
  WorkerInferenceEventParams,
  WorkerInferenceStartParams,
  WorkerInferenceStartResult,
  WorkerInferenceTerminalFrame,
  WorkerInferenceTerminalOutcome,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import type { OpenClawConfig } from "../../config/types.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import type { WorkerInferenceStore, WorkerInferenceTurnInput } from "./inference-store.js";

type WorkerInferenceFenceReason = Extract<
  WorkerInferenceErrorReason,
  "epoch-mismatch" | "session-not-attached"
>;

export type WorkerInferenceSink = {
  connectionId: string;
  send(frame: WorkerInferenceEventFrame | WorkerInferenceTerminalFrame): void;
};

export type WorkerInferenceExecutor = (params: {
  identity: WorkerConnectionIdentity;
  request: WorkerInferenceStartParams;
  signal: AbortSignal;
  emit: (event: WorkerInferenceEventParams["event"]) => void;
  isCurrent(): boolean;
  sessionTarget: BoundAgentRunSessionTarget;
  config?: OpenClawConfig;
}) => Promise<WorkerInferenceTerminalOutcome>;

export type RevalidateInference = () => WorkerInferenceFenceReason | null;

export type WorkerInferenceStartApplicationResult =
  | {
      ok: true;
      result: WorkerInferenceStartResult;
      launch(): void;
    }
  | { ok: false; reason: WorkerInferenceErrorReason };

export type WorkerInferenceCancelApplicationResult =
  | { ok: true; result: WorkerInferenceCancelResult }
  | { ok: false; reason: WorkerInferenceErrorReason };

export type InferenceTurnIdentity = Pick<
  WorkerInferenceTurnInput,
  "sessionId" | "runEpoch" | "runId" | "turnId"
>;

export type ActiveInference = {
  claimKey: string;
  storeKey: string;
  identity: WorkerConnectionIdentity;
  request: WorkerInferenceStartParams;
  sessionTarget: BoundAgentRunSessionTarget;
  requestHash: string;
  storeInput: WorkerInferenceTurnInput;
  sink: WorkerInferenceSink;
  sinkReady: boolean;
  pendingFrames: Array<WorkerInferenceEventFrame | WorkerInferenceTerminalFrame>;
  /** Original source authority stays bound while a reconnect refreshes transport. */
  readonly assertSourceCurrent?: () => void;
  revalidate?: RevalidateInference;
  controller: AbortController;
  seq: number;
  streamedBytes: number;
  launched: boolean;
  settled: boolean;
  abortReason?: WorkerInferenceErrorReason;
  begun?: Promise<Awaited<ReturnType<WorkerInferenceStore["begin"]>> | undefined>;
  admission?: Promise<WorkerInferenceStartApplicationResult>;
  terminal?: Promise<void>;
  failure?: { error: unknown };
  authorityFailure?: { error: unknown };
  terminalOutcome?: WorkerInferenceTerminalOutcome;
  replay?: boolean;
};

export type WorkerInferenceManagerOptions = {
  execute: WorkerInferenceExecutor;
  store?: WorkerInferenceStore;
  getConfig?: () => OpenClawConfig;
  requestMaxBytes?: number;
  streamMaxBytes?: number;
};
