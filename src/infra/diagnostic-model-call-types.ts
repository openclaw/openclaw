import type { DiagnosticBaseEvent } from "./diagnostic-event-snapshot.js";
import type { DiagnosticMemoryUsage } from "./diagnostic-process-types.js";
import type { DiagnosticRunScopeFields } from "./diagnostic-run-types.js";

export type DiagnosticModelCallPromptStats = Readonly<{
  inputMessagesCount?: number;
  inputMessagesChars?: number;
  systemPromptChars?: number;
  toolDefinitionsCount?: number;
  toolDefinitionsChars?: number;
  totalChars?: number;
}>;

export type DiagnosticModelCallUsage = Readonly<{
  usageReport?: { state: "available" | "unavailable" };
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  cacheWrite5m?: number;
  reasoningTokens?: number;
  promptTokens?: number;
  total?: number;
}>;

export type DiagnosticModelCallTerminalFields = {
  durationMs: number;
  providerProcessingMs?: number;
  providerWaitEstimateMs?: number;
  requestPayloadBytes?: number;
  responseStreamBytes?: number;
  timeToFirstByteMs?: number;
  usage?: DiagnosticModelCallUsage;
  /** Provider-reported model from the terminal message; `model` stays the requested id, never synthesized. */
  responseModel?: string;
};
type DiagnosticModelCallBaseEvent = DiagnosticBaseEvent &
  Pick<DiagnosticRunScopeFields, "sessionKey" | "sessionId"> & {
    runId: string;
    agentId?: string;
    callId: string;
    provider: string;
    model: string;
    api?: string;
    transport?: string;
    /** Defaults to request for emitters created before turn-level CLI diagnostics. */
    observationUnit?: "request" | "turn";
    contextTokenBudget?: number;
    contextWindowSource?: "model" | "modelsConfig" | "agentContextTokens" | "default";
    contextWindowReferenceTokens?: number;
    upstreamRequestIdHash?: string;
    promptStats?: DiagnosticModelCallPromptStats;
  };

export type DiagnosticModelCallStartedEvent = DiagnosticModelCallBaseEvent & {
  type: "model.call.started";
};

type DiagnosticModelCallEndedEvent = DiagnosticModelCallBaseEvent &
  DiagnosticModelCallTerminalFields;

export type DiagnosticModelCallCompletedEvent = DiagnosticModelCallEndedEvent & {
  type: "model.call.completed";
};

export type DiagnosticModelCallErrorEvent = DiagnosticModelCallEndedEvent & {
  type: "model.call.error";
  errorCategory: string;
  failureKind?: "aborted" | "connection_closed" | "connection_reset" | "terminated" | "timeout";
  memory?: DiagnosticMemoryUsage;
};

export type DiagnosticModelResponseObservedEvent = Omit<
  DiagnosticModelCallBaseEvent,
  "observationUnit" | "promptStats" | "upstreamRequestIdHash"
> & {
  type: "model.response.observed";
  upstreamRequestIdHash: string;
  /** The event timestamp is receipt time, not a provider completion boundary. */
  timestampSource: "receipt";
  usageSource: "native-normalized";
  usageScope: "response";
  usage?: DiagnosticModelCallUsage;
};
