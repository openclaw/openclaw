import { randomUUID } from "node:crypto";
import { formatErrorStackWithMessage } from "@openclaw/normalization-core/error-coercion";
import type { ExecProcessFailureKind } from "../agents/bash-tools.exec-output.js";
import type { EmbeddedAgentExecutionPhaseInfo } from "../agents/embedded-agent-runner/execution-phase.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pluginInstanceInvocation } from "../plugins/plugin-instance-invocation.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { registerListener } from "../shared/listeners.js";
import type { TalkBrain, TalkEventType, TalkMode, TalkTransport } from "../talk/talk-events.js";
import {
  hasInternalDiagnosticEventInterest,
  isInternalDiagnosticEventInterested,
  resetInternalDiagnosticEventListenerPresence,
  setInternalDiagnosticEventListenerCounts,
  type InternalDiagnosticEventInterest,
  updateInternalDiagnosticEventInterest,
} from "./diagnostic-event-listener-presence.js";
import {
  ASYNC_DIAGNOSTIC_EVENT_NAMES,
  PRIORITY_ASYNC_DIAGNOSTIC_EVENT_NAMES,
  PUBLIC_EXCLUDED_DIAGNOSTIC_EVENT_NAMES,
} from "./diagnostic-event-queue-policy.js";
import {
  type DiagnosticBaseEvent,
  type DiagnosticEventMetadata,
  captureQueuedDiagnosticEvent,
  enrichDiagnosticEvent,
  cloneDiagnosticValueForListener,
  createDiagnosticMetadataForListener,
  createInternalDiagnosticMetadata,
  createDiagnosticValueForListeners,
} from "./diagnostic-event-snapshot.js";
import {
  consumeCoreModelRequestLifecycleDiagnosticEvent,
  CORE_MODEL_REQUEST_LIFECYCLE_METADATA_KEY,
  type CoreModelRequestLifecycleProvenance,
} from "./diagnostic-model-request-provenance.js";
import type { DiagnosticModelUsageFields } from "./diagnostic-model-usage-types.js";
import { isTrustedOtelDiagnosticListener } from "./diagnostic-otel-listener-provenance.js";
import { consumeHostPluginUsageDiagnosticEvent } from "./diagnostic-plugin-usage-provenance.js";
import type {
  DiagnosticMemoryUsage,
  DiagnosticChildProcessSpawnFields,
  DiagnosticMemoryPressureFields,
  DiagnosticAsyncQueueDroppedFields,
  DiagnosticRuntimeMeasurementFields,
  DiagnosticWorkerRequestFields,
} from "./diagnostic-process-types.js";
import type { DiagnosticGatewayFields } from "./diagnostic-rpc-types.js";
import type {
  DiagnosticAgentCommentaryFields,
  DiagnosticRunScopeFields,
} from "./diagnostic-run-types.js";
import {
  consumeCoreSemanticRunProgressDiagnosticEvent,
  CORE_SEMANTIC_RUN_PROGRESS_METADATA_KEY,
  type CoreSemanticRunProgressProvenance,
} from "./diagnostic-semantic-run-progress-provenance.js";
import {
  consumeToolExecutionLivenessDiagnosticEvent,
  TOOL_EXECUTION_LIVENESS_METADATA_KEY,
  type DiagnosticToolExecutionLiveness,
} from "./diagnostic-tool-execution-liveness.js";
import { getActiveDiagnosticTraceContext } from "./diagnostic-trace-context.js";
import {
  hasDiagnosticTracePropagationConsumer,
  prepareDiagnosticTracePropagation,
  resetDiagnosticTracePropagationForTest,
  shouldPrepareDiagnosticTracePropagation,
} from "./diagnostic-trace-propagation.js";
import {
  MAX_DIAGNOSTIC_WORKER_SLOTS,
  normalizeDiagnosticWorkerScript,
} from "./worker-diagnostic-script.js";

export { isInternalDiagnosticEventMetadata } from "./diagnostic-event-snapshot.js";
export type { DiagnosticEventMetadata } from "./diagnostic-event-snapshot.js";

export type { DiagnosticMemoryUsage } from "./diagnostic-process-types.js";

export type DiagnosticSessionState = "idle" | "processing" | "waiting";

type DiagnosticSessionEvent = DiagnosticBaseEvent &
  Pick<DiagnosticRunScopeFields, "sessionKey" | "sessionId">;

type DiagnosticUsageEvent = DiagnosticSessionEvent & DiagnosticModelUsageFields;

export type DiagnosticFailoverEvent = DiagnosticSessionEvent & {
  type: "model.failover";
  lane?: string;
  fromProvider?: string;
  fromModel?: string;
  toProvider?: string;
  toModel?: string;
  reason: string;
  cascadeDepth?: number;
  suspended?: boolean;
};

type DiagnosticSecurityEventActor = {
  kind: "operator" | "node" | "agent" | "plugin" | "channel_sender" | "system";
  idHash?: string;
  deviceIdHash?: string;
  channel?: string;
  role?: string;
  scopes?: string[];
};

type DiagnosticSecurityEventTarget = {
  kind:
    | "gateway"
    | "device"
    | "node"
    | "tool"
    | "plugin"
    | "secret_ref"
    | "channel"
    | "config"
    | "session";
  idHash?: string;
  name?: string;
  owner?: string;
};

type DiagnosticSecurityEventPolicy = {
  id?: string;
  decision?: "allow" | "deny" | "ask" | "auto" | "full" | "not_applicable";
  reason?: string;
};

type DiagnosticSecurityEventControl = {
  id?: string;
  family?: "auth" | "authorization" | "approval" | "sandbox" | "secret" | "supply_chain";
};

type DiagnosticSecurityEvent = DiagnosticBaseEvent & {
  type: "security.event";
  eventId: string;
  category:
    | "auth"
    | "approval"
    | "tool"
    | "plugin"
    | "secret"
    | "channel"
    | "config"
    | "audit"
    | "telemetry";
  action: string;
  outcome: "success" | "failure" | "denied" | "error";
  severity: "info" | "low" | "medium" | "high" | "critical";
  actor?: DiagnosticSecurityEventActor;
  target?: DiagnosticSecurityEventTarget;
  policy?: DiagnosticSecurityEventPolicy;
  control?: DiagnosticSecurityEventControl;
  reason?: string;
  attributes?: Record<string, string | number | boolean>;
};

export type DiagnosticSecurityEventInput = Omit<
  DiagnosticSecurityEvent,
  "eventId" | "seq" | "ts" | "type"
> & {
  eventId?: string;
};

type DiagnosticWebhookReceivedEvent = DiagnosticBaseEvent & {
  type: "webhook.received";
  channel: string;
  updateType?: string;
  chatId?: number | string;
};

type DiagnosticWebhookProcessedEvent = DiagnosticBaseEvent & {
  type: "webhook.processed";
  channel: string;
  updateType?: string;
  chatId?: number | string;
  durationMs?: number;
};

type DiagnosticWebhookErrorEvent = DiagnosticBaseEvent & {
  type: "webhook.error";
  channel: string;
  updateType?: string;
  chatId?: number | string;
  error: string;
};

type DiagnosticMessageQueuedEvent = DiagnosticSessionEvent & {
  type: "message.queued";
  channel?: string;
  source: string;
  queueDepth?: number;
};

type DiagnosticMessageReceivedEvent = DiagnosticSessionEvent & {
  type: "message.received";
  channel?: string;
  messageId?: number | string;
  chatId?: number | string;
  source: string;
};

type DiagnosticMessageDispatchStartedEvent = DiagnosticSessionEvent & {
  type: "message.dispatch.started";
  channel?: string;
  source: string;
};

type DiagnosticMessageDispatchCompletedEvent = DiagnosticSessionEvent & {
  type: "message.dispatch.completed";
  channel?: string;
  source: string;
  durationMs: number;
  outcome: "completed" | "skipped" | "error";
  reason?: string;
  error?: string;
};

type DiagnosticMessageProcessedEvent = DiagnosticSessionEvent & {
  type: "message.processed";
  channel: string;
  messageId?: number | string;
  chatId?: number | string;
  agentId?: string;
  durationMs?: number;
  outcome: "completed" | "skipped" | "error";
  reason?: string;
  error?: string;
};

export type DiagnosticMessageDeliveryKind = "text" | "media" | "edit" | "reaction" | "other";

type DiagnosticMessageDeliveryBaseEvent = DiagnosticBaseEvent & {
  channel: string;
  sessionKey?: string;
  deliveryKind: DiagnosticMessageDeliveryKind;
};

type DiagnosticMessageDeliveryStartedEvent = DiagnosticMessageDeliveryBaseEvent & {
  type: "message.delivery.started";
};

type DiagnosticMessageDeliveryCompletedEvent = DiagnosticMessageDeliveryBaseEvent & {
  type: "message.delivery.completed";
  durationMs: number;
  resultCount: number;
};

type DiagnosticMessageDeliveryErrorEvent = DiagnosticMessageDeliveryBaseEvent & {
  type: "message.delivery.error";
  durationMs: number;
  errorCategory: string;
};

type DiagnosticTalkEvent = DiagnosticBaseEvent & {
  type: "talk.event";
  sessionId?: string;
  turnId?: string;
  captureId?: string;
  talkEventType: TalkEventType;
  mode: TalkMode;
  transport: TalkTransport;
  brain: TalkBrain;
  provider?: string;
  final?: boolean;
  durationMs?: number;
  byteLength?: number;
};

type DiagnosticSessionStateEvent = DiagnosticSessionEvent & {
  type: "session.state";
  prevState?: DiagnosticSessionState;
  state: DiagnosticSessionState;
  reason?: string;
  queueDepth?: number;
};

export type DiagnosticSessionActiveWorkKind = "embedded_run" | "model_call" | "tool_call";

type DiagnosticSessionAttentionClassification =
  | "long_running"
  | "blocked_tool_call"
  | "stalled_agent_run"
  | "stale_session_state";

type DiagnosticSessionAttentionBaseEvent = DiagnosticSessionEvent & {
  state: DiagnosticSessionState;
  ageMs: number;
  queueDepth?: number;
  reason?: string;
  classification: DiagnosticSessionAttentionClassification;
  activeWorkKind?: DiagnosticSessionActiveWorkKind;
  lastProgressAgeMs?: number;
  lastProgressReason?: string;
  activeToolName?: string;
  activeToolCallId?: string;
  activeToolAgeMs?: number;
  repeatedRequestNoProgressAgeMs?: number;
  terminalProgressStale?: boolean;
};

type DiagnosticSessionLongRunningEvent = DiagnosticSessionAttentionBaseEvent & {
  type: "session.long_running";
  classification: "long_running";
};

type DiagnosticSessionStalledEvent = DiagnosticSessionAttentionBaseEvent & {
  type: "session.stalled";
  classification: "blocked_tool_call" | "stalled_agent_run";
};

type DiagnosticSessionStuckEvent = DiagnosticSessionAttentionBaseEvent & {
  type: "session.stuck";
  classification: "stale_session_state";
};

type DiagnosticSessionRecoveryStatus = "aborted" | "released" | "skipped" | "noop" | "failed";

type DiagnosticSessionRecoveryBaseEvent = DiagnosticSessionEvent & {
  state: DiagnosticSessionState;
  stateGeneration?: number;
  ageMs: number;
  queueDepth?: number;
  reason?: string;
  activeWorkKind?: DiagnosticSessionActiveWorkKind;
  allowActiveAbort?: boolean;
};

type DiagnosticSessionRecoveryRequestedEvent = DiagnosticSessionRecoveryBaseEvent & {
  type: "session.recovery.requested";
};

type DiagnosticSessionRecoveryCompletedEvent = DiagnosticSessionRecoveryBaseEvent & {
  type: "session.recovery.completed";
  status: DiagnosticSessionRecoveryStatus;
  action: string;
  outcomeReason?: string;
  released?: number;
  stale?: boolean;
};

type DiagnosticSessionTurnCreatedEvent = DiagnosticSessionEvent & {
  type: "session.turn.created";
  runId: string;
  agentId?: string;
  channel?: string;
  trigger: "user" | "event" | "heartbeat";
};

type DiagnosticLaneEnqueueEvent = DiagnosticBaseEvent & {
  type: "queue.lane.enqueue";
  lane: string;
  queueSize: number;
};

type DiagnosticLaneDequeueEvent = DiagnosticBaseEvent & {
  type: "queue.lane.dequeue";
  lane: string;
  queueSize: number;
  waitMs: number;
};

type DiagnosticRunAttemptEvent = DiagnosticSessionEvent & {
  type: "run.attempt";
  runId: string;
  attempt: number;
};

type DiagnosticRunProgressEvent = DiagnosticSessionEvent & {
  type: "run.progress";
  runId?: string;
  reason: string;
};

/**
 * Session-correlated embedded-runner execution milestone. Emitted for every
 * phase transition so external status surfaces can render turn startup
 * without a control-UI subscription. `phase` is the closed
 * EmbeddedAgentExecutionPhase contract (type-only import keeps this module
 * runtime-independent of the agents layer).
 */
type DiagnosticRunExecutionPhaseEvent = DiagnosticBaseEvent &
  EmbeddedAgentExecutionPhaseInfo & {
    type: "run.execution_phase";
    sessionKey?: string;
    sessionId: string;
    runId: string;
  };

type DiagnosticHeartbeatEvent = DiagnosticBaseEvent & {
  type: "diagnostic.heartbeat";
  webhooks: {
    received: number;
    processed: number;
    errors: number;
  };
  active: number;
  waiting: number;
  queued: number;
};

export type DiagnosticLivenessWarningReason = "event_loop_delay" | "event_loop_utilization" | "cpu";

export type DiagnosticPhaseDetails = Record<string, string | number | boolean>;

export type DiagnosticPhaseSnapshot = {
  name: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  cpuUserMs?: number;
  cpuSystemMs?: number;
  cpuTotalMs?: number;
  cpuCoreRatio?: number;
  details?: DiagnosticPhaseDetails;
};

type DiagnosticLivenessWarningEvent = DiagnosticBaseEvent & {
  type: "diagnostic.liveness.warning";
  reasons: DiagnosticLivenessWarningReason[];
  intervalMs: number;
  degradedSinceMs?: number;
  eventLoopDelayP99Ms?: number;
  eventLoopDelayMaxMs?: number;
  eventLoopUtilization?: number;
  cpuUserMs?: number;
  cpuSystemMs?: number;
  cpuTotalMs?: number;
  cpuCoreRatio?: number;
  active: number;
  waiting: number;
  queued: number;
  phase?: string;
  recentPhases?: DiagnosticPhaseSnapshot[];
  activeWorkLabels?: string[];
  waitingWorkLabels?: string[];
  queuedWorkLabels?: string[];
};

type DiagnosticPhaseCompletedEvent = DiagnosticBaseEvent &
  DiagnosticPhaseSnapshot & {
    type: "diagnostic.phase.completed";
  };

export type DiagnosticToolLoopEvent = DiagnosticSessionEvent & {
  type: "tool.loop";
  agentId?: string;
  toolName: string;
  level: "warning" | "critical";
  action: "warn" | "block";
  detector:
    | "generic_repeat"
    | "argument_churn"
    | "unknown_tool_repeat"
    | "known_poll_no_progress"
    | "global_circuit_breaker"
    | "ping_pong";
  count: number;
  message: string;
  pairedToolName?: string;
};

export type DiagnosticToolParamsSummary =
  | { kind: "object" }
  | { kind: "array"; length: number }
  | { kind: "string"; length: number }
  | { kind: "number" | "boolean" | "null" | "undefined" | "other" };

export type DiagnosticToolSource = "channel" | "core" | "mcp" | "plugin";
export type DiagnosticToolTerminalReason = "failed" | "cancelled" | "timed_out";

type DiagnosticToolExecutionBaseEvent = DiagnosticSessionEvent & {
  runId?: string;
  agentId?: string;
  /** Authoritative lifecycle time from the tool runtime, when it exposes one. */
  sourceTimestampMs?: number;
  toolName: string;
  toolSource?: DiagnosticToolSource;
  toolOwner?: string;
  toolCallId?: string;
  paramsSummary?: DiagnosticToolParamsSummary;
  /** Deterministic mutation classification computed before tool execution. */
  mutatingAction?: boolean;
};

type DiagnosticToolExecutionStartedEvent = DiagnosticToolExecutionBaseEvent & {
  type: "tool.execution.started";
};

type DiagnosticToolExecutionCompletedEvent = DiagnosticToolExecutionBaseEvent & {
  type: "tool.execution.completed";
  durationMs: number;
};

type DiagnosticToolExecutionErrorEvent = DiagnosticToolExecutionBaseEvent & {
  type: "tool.execution.error";
  durationMs: number;
  errorCategory: string;
  errorCode?: string;
  terminalReason?: DiagnosticToolTerminalReason;
};

type DiagnosticToolExecutionBlockedEvent = DiagnosticToolExecutionBaseEvent & {
  type: "tool.execution.blocked";
  deniedReason: string;
  reason: string;
};

type DiagnosticSkillTelemetrySource = "bundled" | "unknown" | "workspace";
type DiagnosticSkillActivation = "command" | "read";

export type DiagnosticSkillUsedEvent = DiagnosticSessionEvent & {
  type: "skill.used";
  runId?: string;
  agentId?: string;
  skillName: string;
  skillSource: DiagnosticSkillTelemetrySource;
  activation: DiagnosticSkillActivation;
  toolName?: string;
  toolCallId?: string;
};

type DiagnosticExecProcessCompletedEvent = DiagnosticBaseEvent & {
  type: "exec.process.completed";
  sessionKey?: string;
  target: "host" | "sandbox";
  mode: "child" | "pty";
  outcome: "completed" | "failed";
  durationMs: number;
  commandLength: number;
  exitCode?: number;
  exitSignal?: string;
  timedOut?: boolean;
  failureKind?: ExecProcessFailureKind;
};

type DiagnosticExecApprovalFollowupSuppressedEvent = DiagnosticBaseEvent & {
  type: "exec.approval.followup_suppressed";
  approvalId: string;
  reason: "session_rebound";
  phase: "direct_delivery" | "gateway_preflight";
};

type DiagnosticRunBaseEvent = DiagnosticBaseEvent & DiagnosticRunScopeFields;

type DiagnosticRunStartedEvent = DiagnosticRunBaseEvent & {
  type: "run.started";
};

type DiagnosticRunCompletedEvent = DiagnosticRunBaseEvent & {
  type: "run.completed";
  durationMs: number;
  outcome: "completed" | "aborted" | "blocked" | "error";
  errorCategory?: string;
  blockedBy?: string;
};

type DiagnosticHarnessRunPhase = "prepare" | "start" | "send" | "resolve" | "cleanup";
export type DiagnosticHarnessRunOutcome = "completed" | "aborted" | "timed_out" | "error";

type DiagnosticHarnessRunBaseEvent = DiagnosticBaseEvent &
  DiagnosticRunScopeFields & {
    harnessId: string;
    pluginId?: string;
  };

export type DiagnosticHarnessRunStartedEvent = DiagnosticHarnessRunBaseEvent & {
  type: "harness.run.started";
};

type DiagnosticAgentCommentaryEvent = DiagnosticBaseEvent & DiagnosticAgentCommentaryFields;

type DiagnosticHarnessRunCompletedEvent = DiagnosticHarnessRunBaseEvent & {
  type: "harness.run.completed";
  durationMs: number;
  outcome: DiagnosticHarnessRunOutcome;
  resultClassification?: "empty" | "reasoning-only" | "planning-only";
  yieldDetected?: boolean;
  itemLifecycle?: {
    startedCount: number;
    completedCount: number;
    activeCount: number;
  };
};

export type DiagnosticHarnessRunErrorEvent = DiagnosticHarnessRunBaseEvent & {
  type: "harness.run.error";
  durationMs: number;
  phase: DiagnosticHarnessRunPhase;
  errorCategory: string;
  cleanupFailed?: boolean;
};

type DiagnosticModelCallBaseEvent = DiagnosticSessionEvent & {
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

type DiagnosticModelCallStartedEvent = DiagnosticModelCallBaseEvent & {
  type: "model.call.started";
};

type DiagnosticModelCallEndedEvent = DiagnosticModelCallBaseEvent & {
  durationMs: number;
  providerProcessingMs?: number;
  providerWaitEstimateMs?: number;
  requestPayloadBytes?: number;
  responseStreamBytes?: number;
  timeToFirstByteMs?: number;
  usage?: DiagnosticModelCallUsage;
};

type DiagnosticModelCallCompletedEvent = DiagnosticModelCallEndedEvent & {
  type: "model.call.completed";
};

type DiagnosticModelCallErrorEvent = DiagnosticModelCallEndedEvent & {
  type: "model.call.error";
  errorCategory: string;
  failureKind?: "aborted" | "connection_closed" | "connection_reset" | "terminated" | "timeout";
  memory?: DiagnosticMemoryUsage;
};

type DiagnosticModelResponseObservedEvent = Omit<
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

type DiagnosticModelCallPromptStats = Readonly<{
  inputMessagesCount?: number;
  inputMessagesChars?: number;
  systemPromptChars?: number;
  toolDefinitionsCount?: number;
  toolDefinitionsChars?: number;
  totalChars?: number;
}>;

type DiagnosticModelCallUsage = Readonly<{
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoningTokens?: number;
  promptTokens?: number;
  total?: number;
}>;

type DiagnosticContextAssembledEvent = DiagnosticSessionEvent & {
  type: "context.assembled";
  runId: string;
  provider: string;
  model: string;
  channel?: string;
  trigger?: string;
  messageCount: number;
  historyTextChars: number;
  historyImageBlocks: number;
  maxMessageTextChars: number;
  systemPromptChars: number;
  promptChars: number;
  promptImages: number;
  contextTokenBudget?: number;
  reserveTokens?: number;
};

type DiagnosticMemorySampleEvent = DiagnosticBaseEvent & {
  type: "diagnostic.memory.sample";
  memory: DiagnosticMemoryUsage;
  uptimeMs?: number;
};

export type DiagnosticMemoryPressureEvent = DiagnosticBaseEvent & DiagnosticMemoryPressureFields;

type DiagnosticPayloadLargeEvent = DiagnosticBaseEvent & {
  type: "payload.large";
  surface: string;
  action: "rejected" | "truncated" | "chunked";
  bytes?: number;
  limitBytes?: number;
  count?: number;
  channel?: string;
  pluginId?: string;
  reason?: string;
};

type DiagnosticLogRecordEvent = DiagnosticBaseEvent & {
  type: "log.record";
  level: string;
  message: string;
  loggerName?: string;
  loggerParents?: string[];
  attributes?: Record<string, string | number | boolean>;
  code?: {
    line?: number;
    functionName?: string;
  };
};

type DiagnosticTelemetryExporterEvent = DiagnosticBaseEvent & {
  type: "telemetry.exporter";
  exporter: string;
  signal: "traces" | "metrics" | "logs";
  status: "started" | "failure" | "dropped";
  reason?:
    | "configured"
    | "emit_failed"
    | "handler_failed"
    | "queue_full"
    | "shutdown_failed"
    | "start_failed"
    | "unsupported_protocol";
  errorCategory?: string;
};

export type DiagnosticEventPayload =
  | (DiagnosticBaseEvent & DiagnosticGatewayFields)
  | (DiagnosticBaseEvent & DiagnosticRuntimeMeasurementFields)
  | (DiagnosticBaseEvent & DiagnosticWorkerRequestFields)
  | DiagnosticUsageEvent
  | DiagnosticWebhookReceivedEvent
  | DiagnosticWebhookProcessedEvent
  | DiagnosticWebhookErrorEvent
  | DiagnosticMessageQueuedEvent
  | DiagnosticMessageReceivedEvent
  | DiagnosticMessageDispatchStartedEvent
  | DiagnosticMessageDispatchCompletedEvent
  | DiagnosticMessageProcessedEvent
  | DiagnosticMessageDeliveryStartedEvent
  | DiagnosticMessageDeliveryCompletedEvent
  | DiagnosticMessageDeliveryErrorEvent
  | DiagnosticTalkEvent
  | DiagnosticSessionStateEvent
  | DiagnosticSessionLongRunningEvent
  | DiagnosticSessionStalledEvent
  | DiagnosticSessionStuckEvent
  | DiagnosticSessionRecoveryRequestedEvent
  | DiagnosticSessionRecoveryCompletedEvent
  | DiagnosticSessionTurnCreatedEvent
  | DiagnosticLaneEnqueueEvent
  | DiagnosticLaneDequeueEvent
  | DiagnosticRunAttemptEvent
  | DiagnosticRunProgressEvent
  | DiagnosticRunExecutionPhaseEvent
  | DiagnosticHeartbeatEvent
  | DiagnosticLivenessWarningEvent
  | DiagnosticPhaseCompletedEvent
  | DiagnosticToolLoopEvent
  | DiagnosticToolExecutionStartedEvent
  | DiagnosticToolExecutionCompletedEvent
  | DiagnosticToolExecutionErrorEvent
  | DiagnosticToolExecutionBlockedEvent
  | DiagnosticSkillUsedEvent
  | DiagnosticExecProcessCompletedEvent
  | DiagnosticExecApprovalFollowupSuppressedEvent
  | DiagnosticRunStartedEvent
  | DiagnosticRunCompletedEvent
  | DiagnosticHarnessRunStartedEvent
  | DiagnosticAgentCommentaryEvent
  | DiagnosticHarnessRunCompletedEvent
  | DiagnosticHarnessRunErrorEvent
  | DiagnosticModelCallStartedEvent
  | DiagnosticModelCallCompletedEvent
  | DiagnosticModelCallErrorEvent
  | DiagnosticModelResponseObservedEvent
  | (DiagnosticBaseEvent & {
      type: "secret.egress";
      outcome: "forwarded" | "refused";
      substituted: boolean;
    })
  | (DiagnosticBaseEvent & {
      type: "tool.catalog";
      source: "builtin" | "client";
      mode: "code-mode" | "tool-search";
      toolCount: number;
    })
  | DiagnosticContextAssembledEvent
  | DiagnosticMemorySampleEvent
  | DiagnosticMemoryPressureEvent
  | (DiagnosticBaseEvent & DiagnosticChildProcessSpawnFields)
  | DiagnosticPayloadLargeEvent
  | DiagnosticLogRecordEvent
  | DiagnosticSecurityEvent
  | DiagnosticTelemetryExporterEvent
  | (DiagnosticBaseEvent & DiagnosticAsyncQueueDroppedFields)
  | DiagnosticFailoverEvent;

type DiagnosticNonSecurityEventPayload = Exclude<DiagnosticEventPayload, DiagnosticSecurityEvent>;

export type DiagnosticEventInput = DiagnosticNonSecurityEventPayload extends infer Event
  ? Event extends DiagnosticEventPayload
    ? Omit<Event, "seq" | "ts">
    : never
  : never;

type TrustedToolExecutionEventInput = Extract<
  DiagnosticEventInput,
  { type: TrustedToolExecutionEvent["type"] }
>;
type TrustedSkillUsedEventInput = Extract<DiagnosticEventInput, { type: "skill.used" }>;

type DiagnosticDispatchInput = DiagnosticEventInput | Omit<DiagnosticSecurityEvent, "seq" | "ts">;

type InternalDiagnosticEventMetadata = DiagnosticEventMetadata &
  Readonly<{
    [TOOL_EXECUTION_LIVENESS_METADATA_KEY]?: DiagnosticToolExecutionLiveness;
    [CORE_MODEL_REQUEST_LIFECYCLE_METADATA_KEY]?: CoreModelRequestLifecycleProvenance;
    // String metadata survives duplicate module instances sharing dispatcher state;
    // only the non-SDK core emitter can set this semantic authority.
    [CORE_SEMANTIC_RUN_PROGRESS_METADATA_KEY]?: CoreSemanticRunProgressProvenance;
  }>;

export type DiagnosticModelCallContent = Readonly<{
  inputMessages?: unknown;
  outputMessages?: unknown;
  systemPrompt?: string;
  toolDefinitions?: unknown;
}>;

type DiagnosticToolCallContent = Readonly<{ toolInput?: unknown; toolOutput?: unknown }>;

type DiagnosticSkillUsagePrivateData = Readonly<{ skillFile: string }>;

export type DiagnosticEventPrivateData = Readonly<{
  /** Raw failure text for trusted diagnostics exporters; never part of the public event payload. */
  errorMessage?: string;
  modelContent?: DiagnosticModelCallContent;
  skillUsage?: DiagnosticSkillUsagePrivateData;
  toolContent?: DiagnosticToolCallContent;
  // Content gated by captureContent policy; routed privately so it never reaches untrusted onDiagnosticEvent listeners.
  messageContent?: { userPrompt?: string; finalResponse?: string };
  // Same gating as messageContent but for harness.run started/completed events.
  harnessContent?: { userPrompt?: string; finalResponse?: string };
}>;

type DiagnosticEventListener = (
  evt: DiagnosticEventPayload,
  metadata: DiagnosticEventMetadata,
) => void;

type TrustedDiagnosticEventListener = (
  evt: DiagnosticEventPayload,
  metadata: DiagnosticEventMetadata,
  privateData: DiagnosticEventPrivateData,
) => void;

type TrustedDiagnosticEventListenerOptions = Readonly<{ includePrivateData?: boolean }>;
type TrustedDiagnosticEventInterest = InternalDiagnosticEventInterest<
  DiagnosticEventPayload["type"]
> &
  TrustedDiagnosticEventListenerOptions;

const EMPTY_DIAGNOSTIC_PRIVATE_DATA: DiagnosticEventPrivateData = Object.freeze({});

export type TrustedToolExecutionEvent = Extract<
  DiagnosticEventPayload,
  {
    type:
      | "tool.execution.started"
      | "tool.execution.completed"
      | "tool.execution.error"
      | "tool.execution.blocked";
  }
>;

type TrustedToolExecutionEventListener = (event: TrustedToolExecutionEvent) => void;

type QueuedDiagnosticEvent = {
  event: DiagnosticEventPayload;
  metadata: DiagnosticEventMetadata;
  privateData?: DiagnosticEventPrivateData;
  hostPluginId?: string;
  trustedListenersOnly?: boolean;
};

type DiagnosticEventsGlobalState = {
  marker: symbol;
  enabled: boolean;
  seq: number;
  listeners: Map<
    DiagnosticEventListener,
    InternalDiagnosticEventInterest<DiagnosticEventPayload["type"]> | undefined
  >;
  trustedListeners: Map<TrustedDiagnosticEventListener, TrustedDiagnosticEventInterest | undefined>;
  toolExecutionListeners: Set<TrustedToolExecutionEventListener>;
  toolExecutionSeq: number;
  dispatchDepth: number;
  asyncQueue: QueuedDiagnosticEvent[];
  asyncDrainScheduled: boolean;
  asyncDroppedEvents: number;
  asyncDroppedTrustedEvents: number;
  asyncDroppedUntrustedEvents: number;
  asyncDroppedPriorityEvents: number;
};

const MAX_ASYNC_DIAGNOSTIC_EVENTS = 10_000;
const MAX_ASYNC_DIAGNOSTIC_EVENTS_PER_TURN = 100;
const DIAGNOSTIC_EVENTS_STATE_KEY = Symbol.for("openclaw.diagnosticEvents.state.v1");
const ASYNC_DIAGNOSTIC_EVENT_TYPES = new Set<DiagnosticEventPayload["type"]>(
  ASYNC_DIAGNOSTIC_EVENT_NAMES,
);
const PRIORITY_ASYNC_DIAGNOSTIC_EVENT_TYPES = new Set<DiagnosticEventPayload["type"]>(
  PRIORITY_ASYNC_DIAGNOSTIC_EVENT_NAMES,
);

const diagnosticEventsState = resolveGlobalSingleton<DiagnosticEventsGlobalState>(
  DIAGNOSTIC_EVENTS_STATE_KEY,
  () => ({
    marker: DIAGNOSTIC_EVENTS_STATE_KEY,
    enabled: true,
    seq: 0,
    listeners: new Map(),
    trustedListeners: new Map(),
    toolExecutionListeners: new Set<TrustedToolExecutionEventListener>(),
    toolExecutionSeq: 0,
    dispatchDepth: 0,
    asyncQueue: [],
    asyncDrainScheduled: false,
    asyncDroppedEvents: 0,
    asyncDroppedTrustedEvents: 0,
    asyncDroppedUntrustedEvents: 0,
    asyncDroppedPriorityEvents: 0,
  }),
);

/** Returns whether diagnostics are enabled for a loaded config; missing config defaults enabled. */
export function isDiagnosticsEnabled(config?: OpenClawConfig): boolean {
  return config?.diagnostics?.enabled !== false;
}

/** Sets the process-wide diagnostic dispatcher enable flag. */
export function setDiagnosticsEnabledForProcess(enabled: boolean): void {
  diagnosticEventsState.enabled = enabled;
}

/** Returns the current process-wide diagnostic dispatcher enable flag. */
export function areDiagnosticsEnabledForProcess(): boolean {
  return diagnosticEventsState.enabled;
}

function dispatchDiagnosticEvent(
  state: DiagnosticEventsGlobalState,
  enriched: DiagnosticEventPayload,
  metadata: DiagnosticEventMetadata,
  privateData?: DiagnosticEventPrivateData,
  options: { hostPluginId?: string; trustedListenersOnly?: boolean } = {},
): void {
  if (state.dispatchDepth > 100) {
    console.error(
      `[diagnostic-events] recursion guard tripped at depth=${state.dispatchDepth}, dropping type=${enriched.type}`,
    );
    return;
  }

  state.dispatchDepth += 1;
  try {
    const eventForListener = createDiagnosticValueForListeners(enriched, true);
    const privateValues = privateData && createDiagnosticValueForListeners(privateData);
    let metadataForListener: DiagnosticEventMetadata | undefined;
    if (!options.trustedListenersOnly) {
      for (const [listener, interest] of state.listeners) {
        if (!isInternalDiagnosticEventInterested(interest, enriched.type, metadata.trusted)) {
          continue;
        }
        try {
          listener(
            eventForListener(),
            (metadataForListener ??= createDiagnosticMetadataForListener(metadata)),
          );
        } catch (err) {
          const errorMessage =
            err instanceof Error ? formatErrorStackWithMessage(err) : String(err);
          console.error(
            `[diagnostic-events] listener error type=${enriched.type} seq=${enriched.seq}: ${errorMessage}`,
          );
        }
      }
    }
    for (const [listener, interest] of state.trustedListeners) {
      if (!isInternalDiagnosticEventInterested(interest, enriched.type, metadata.trusted)) {
        continue;
      }
      try {
        const event = eventForListener();
        metadataForListener ??= createDiagnosticMetadataForListener(metadata);
        const otel = isTrustedOtelDiagnosticListener(listener);
        let privateValue = EMPTY_DIAGNOSTIC_PRIVATE_DATA;
        if (interest?.includePrivateData !== false) {
          privateValue = privateValues?.() ?? EMPTY_DIAGNOSTIC_PRIVATE_DATA;
          if (otel && (options.hostPluginId || Object.hasOwn(privateValue, "hostPluginId"))) {
            // Keep host attribution listener-local for independently updated OTel installs.
            const attributed = { ...privateValue, hostPluginId: options.hostPluginId };
            if (!options.hostPluginId) {
              Reflect.deleteProperty(attributed, "hostPluginId");
            }
            privateValue = Object.freeze(attributed);
          }
        }
        listener(event, metadataForListener, privateValue);
      } catch (err) {
        const errorMessage = err instanceof Error ? formatErrorStackWithMessage(err) : String(err);
        console.error(
          `[diagnostic-events] trusted listener error type=${enriched.type} seq=${enriched.seq}: ${errorMessage}`,
        );
      }
    }
  } finally {
    state.dispatchDepth -= 1;
  }
}

function isPriorityAsyncDiagnosticEvent(entry: QueuedDiagnosticEvent): boolean {
  return entry.metadata.trusted && PRIORITY_ASYNC_DIAGNOSTIC_EVENT_TYPES.has(entry.event.type);
}

function noteAsyncDiagnosticDrop(
  state: DiagnosticEventsGlobalState,
  entry: QueuedDiagnosticEvent,
): void {
  state.asyncDroppedEvents += 1;
  if (entry.metadata.trusted) {
    state.asyncDroppedTrustedEvents += 1;
  } else {
    state.asyncDroppedUntrustedEvents += 1;
  }
  if (isPriorityAsyncDiagnosticEvent(entry)) {
    state.asyncDroppedPriorityEvents += 1;
  }
}

function makeRoomForPriorityAsyncDiagnosticEvent(
  state: DiagnosticEventsGlobalState,
): QueuedDiagnosticEvent | undefined {
  const nonPriorityIndex = state.asyncQueue.findIndex(
    (entry) => !isPriorityAsyncDiagnosticEvent(entry),
  );
  if (nonPriorityIndex >= 0) {
    return state.asyncQueue.splice(nonPriorityIndex, 1)[0];
  }
  return state.asyncQueue.shift();
}

function scheduleAsyncDiagnosticDrain(state: DiagnosticEventsGlobalState): void {
  if (state.asyncDrainScheduled) {
    return;
  }
  state.asyncDrainScheduled = true;
  setImmediate(() => {
    state.asyncDrainScheduled = false;
    const batch = state.asyncQueue.splice(0, MAX_ASYNC_DIAGNOSTIC_EVENTS_PER_TURN);
    for (const entry of batch) {
      dispatchDiagnosticEvent(state, entry.event, entry.metadata, entry.privateData, entry);
    }
    if (state.asyncQueue.length > 0) {
      scheduleAsyncDiagnosticDrain(state);
      return;
    }
    dispatchAsyncDiagnosticDropSummary(state);
  });
}

function dispatchAsyncDiagnosticDropSummary(state: DiagnosticEventsGlobalState): void {
  if (state.asyncDroppedEvents <= 0) {
    return;
  }
  const droppedEvents = state.asyncDroppedEvents;
  const droppedTrustedEvents = state.asyncDroppedTrustedEvents;
  const droppedUntrustedEvents = state.asyncDroppedUntrustedEvents;
  const droppedPriorityEvents = state.asyncDroppedPriorityEvents;
  state.asyncDroppedEvents = 0;
  state.asyncDroppedTrustedEvents = 0;
  state.asyncDroppedUntrustedEvents = 0;
  state.asyncDroppedPriorityEvents = 0;
  const event = enrichDiagnosticEvent(state, {
    type: "diagnostic.async_queue.dropped",
    droppedEvents,
    ...(droppedTrustedEvents > 0 ? { droppedTrustedEvents } : {}),
    ...(droppedUntrustedEvents > 0 ? { droppedUntrustedEvents } : {}),
    ...(droppedPriorityEvents > 0 ? { droppedPriorityEvents } : {}),
    queueLength: state.asyncQueue.length,
    maxQueueLength: MAX_ASYNC_DIAGNOSTIC_EVENTS,
    drainBatchSize: MAX_ASYNC_DIAGNOSTIC_EVENTS_PER_TURN,
  });
  dispatchDiagnosticEvent(state, event, createInternalDiagnosticMetadata(false));
}

/** Waits until async diagnostic events queued when called are no longer pending. */
export async function waitForDiagnosticEventsDrained(): Promise<void> {
  const state = diagnosticEventsState;
  const targetSeq = state.asyncQueue.at(-1)?.event.seq;
  if (targetSeq === undefined) {
    return;
  }
  // The queue is append-ordered by seq, so a newer head means this snapshot drained or dropped.
  while ((state.asyncQueue[0]?.event.seq ?? Number.POSITIVE_INFINITY) <= targetSeq) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

type EmitDiagnosticEventOptions = {
  toolExecutionLiveness?: DiagnosticToolExecutionLiveness;
  allowSecurityEvent?: boolean;
  coreModelRequestLifecycle?: CoreModelRequestLifecycleProvenance;
  coreSemanticRunProgress?: CoreSemanticRunProgressProvenance;
  hostPluginId?: string;
  internal?: boolean;
  privateData?: DiagnosticEventPrivateData;
  trustedTraceContext?: boolean;
  queuedPhase?: true;
};

function emitDiagnosticEventWithTrust(
  event: DiagnosticDispatchInput,
  trusted: boolean,
  options: EmitDiagnosticEventOptions = {},
) {
  const state = diagnosticEventsState;
  const capturedToolEvent =
    trusted && isToolExecutionEventInput(event)
      ? dispatchTrustedToolExecutionEvent(state, event)
      : undefined;
  if (!state.enabled) {
    return;
  }
  if (event.type === "security.event" && options.allowSecurityEvent !== true) {
    return;
  }

  const interested = hasInternalDiagnosticEventInterest(event.type, trusted);
  if (
    !interested &&
    !(trusted && !options.queuedPhase && hasDiagnosticTracePropagationConsumer())
  ) {
    // Sequence numbers describe emitted events, including events without consumers.
    state.seq += 1;
    return;
  }
  // Queued phases already captured their trace, including an absent parent.
  let enriched = enrichDiagnosticEvent(state, capturedToolEvent ?? event, !options.queuedPhase);
  if (trusted && enriched.type === "diagnostic.gc") {
    // SDK producers cross this boundary; native samples already carry bounded attribution.
    switch (enriched.kind) {
      case "scavenge":
      case "mark_sweep_compact":
      case "incremental":
      case "weak_processing":
        break;
      default:
        enriched.kind = undefined;
    }
    switch (enriched.reason) {
      case "none":
      case "forced":
      case "synchronous_phantom_processing":
      case "all_available_garbage":
      case "all_external_memory":
      case "schedule_idle":
      case "construct_retained":
      case "other":
        break;
      default:
        enriched.reason = "other";
    }
    enriched.thread =
      enriched.thread === undefined || enriched.thread === "main"
        ? "main"
        : normalizeDiagnosticWorkerScript(enriched.thread);
    if (
      enriched.thread !== "code-mode-node.worker.js" ||
      typeof enriched.workerSlot !== "number" ||
      !Number.isInteger(enriched.workerSlot) ||
      enriched.workerSlot < 1 ||
      enriched.workerSlot > MAX_DIAGNOSTIC_WORKER_SLOTS
    ) {
      enriched.workerSlot = undefined;
    }
  }
  const { hostPluginId, internal = false, privateData } = options;
  const trustedTraceContext = options.trustedTraceContext === true;
  const metadata: InternalDiagnosticEventMetadata = {
    ...(internal ? createInternalDiagnosticMetadata(trusted) : { trusted }),
    ...(options.toolExecutionLiveness
      ? { [TOOL_EXECUTION_LIVENESS_METADATA_KEY]: options.toolExecutionLiveness }
      : {}),
    ...(options.coreModelRequestLifecycle
      ? { [CORE_MODEL_REQUEST_LIFECYCLE_METADATA_KEY]: options.coreModelRequestLifecycle }
      : {}),
    ...(options.coreSemanticRunProgress
      ? { [CORE_SEMANTIC_RUN_PROGRESS_METADATA_KEY]: options.coreSemanticRunProgress }
      : {}),
    ...(trustedTraceContext ? { trustedTraceContext } : {}),
  };
  const prepareTracePropagation =
    trusted && !options.queuedPhase && shouldPrepareDiagnosticTracePropagation(enriched);

  const queued =
    interested && (options.queuedPhase || ASYNC_DIAGNOSTIC_EVENT_TYPES.has(enriched.type));
  if (queued) {
    if (state.asyncQueue.length >= MAX_ASYNC_DIAGNOSTIC_EVENTS) {
      if (!trusted || !PRIORITY_ASYNC_DIAGNOSTIC_EVENT_TYPES.has(enriched.type)) {
        noteAsyncDiagnosticDrop(state, { event: enriched, metadata, privateData, hostPluginId });
        return;
      }
      const droppedEntry = makeRoomForPriorityAsyncDiagnosticEvent(state);
      if (droppedEntry) {
        noteAsyncDiagnosticDrop(state, droppedEntry);
      }
    }
    const entry = { event: enriched, metadata, privateData, hostPluginId };
    if (!captureQueuedDiagnosticEvent(entry, state.trustedListeners.values())) {
      return;
    }
    enriched = entry.event;
    state.asyncQueue.push(entry);
  }

  if (prepareTracePropagation) {
    if (!queued) {
      enriched = cloneDiagnosticValueForListener(enriched, true);
    }
    prepareDiagnosticTracePropagation(
      cloneDiagnosticValueForListener(enriched),
      createDiagnosticMetadataForListener(metadata),
    );
  }
  if (queued) {
    scheduleAsyncDiagnosticDrain(state);
  } else if (interested) {
    dispatchDiagnosticEvent(state, enriched, metadata, privateData, { hostPluginId });
  }
}

function isToolExecutionEventInput(
  event: DiagnosticDispatchInput,
): event is TrustedToolExecutionEventInput {
  return (
    event.type === "tool.execution.started" ||
    event.type === "tool.execution.completed" ||
    event.type === "tool.execution.error" ||
    event.type === "tool.execution.blocked"
  );
}

function dispatchTrustedToolExecutionEvent(
  state: DiagnosticEventsGlobalState,
  event: TrustedToolExecutionEventInput,
): TrustedToolExecutionEvent | undefined {
  state.toolExecutionSeq += 1;
  if (state.toolExecutionListeners.size === 0) {
    return undefined;
  }
  let enriched: TrustedToolExecutionEvent;
  try {
    enriched = cloneDiagnosticValueForListener(
      {
        ...event,
        seq: state.toolExecutionSeq,
        ts: Date.now(),
      },
      true,
    );
  } catch (error) {
    console.error(
      `[diagnostic-events] tool execution clone error type=${event.type}: ${String(error)}`,
    );
    return undefined;
  }
  const eventForListener = createDiagnosticValueForListeners(enriched);
  for (const listener of state.toolExecutionListeners) {
    try {
      listener(eventForListener());
    } catch (error) {
      console.error(
        `[diagnostic-events] tool execution listener error type=${enriched.type} seq=${enriched.seq}: ${String(error)}`,
      );
    }
  }
  return enriched;
}

/** Emits an untrusted diagnostic event from external/plugin-facing code. */
export function emitDiagnosticEvent(event: DiagnosticEventInput) {
  emitDiagnosticEventWithTrust(event, false);
}

/** Emits an untrusted event whose trace context came from OpenClaw-owned scope. */
export function emitDiagnosticEventWithTrustedTraceContext(event: DiagnosticEventInput) {
  emitDiagnosticEventWithTrust(event, false, { trustedTraceContext: true });
}

/** Emits an untrusted internal diagnostic event; private listener-only payload data
 * stays off the public event payload and reaches trusted private-data listeners only. */
export function emitInternalDiagnosticEvent(
  event: DiagnosticEventInput,
  privateData?: DiagnosticEventPrivateData,
): void {
  emitDiagnosticEventWithTrust(event, false, { internal: true, privateData });
}

/** Returns the latest diagnostic event sequence number assigned in this process. */
export function getInternalDiagnosticEventSequence(): number {
  return diagnosticEventsState.seq;
}

/** Emits a trusted diagnostic event from core/runtime-owned instrumentation. */
export function emitTrustedDiagnosticEvent(event: DiagnosticEventInput) {
  const toolExecutionLiveness = consumeToolExecutionLivenessDiagnosticEvent(event);
  const hostPluginId = consumeHostPluginUsageDiagnosticEvent(event);
  const coreSemanticRunProgress = consumeCoreSemanticRunProgressDiagnosticEvent(event);
  emitDiagnosticEventWithTrust(event, true, {
    ...(toolExecutionLiveness ? { toolExecutionLiveness } : {}),
    ...(hostPluginId ? { hostPluginId, internal: true } : {}),
    ...(coreSemanticRunProgress ? { coreSemanticRunProgress } : {}),
  });
}

/** Queues runtime phase observations without changing synchronous startup phases. */
export function createQueuedDiagnosticPhaseEmitter() {
  const state = diagnosticEventsState;
  const interested = () => {
    if (!state.enabled) {
      return false;
    }
    for (const interest of state.trustedListeners.values()) {
      if (isInternalDiagnosticEventInterested(interest, "diagnostic.phase.completed", true)) {
        return true;
      }
    }
    return false;
  };
  if (!interested()) {
    return undefined;
  }
  const trace = getActiveDiagnosticTraceContext();
  return (phase: DiagnosticPhaseSnapshot) => {
    if (!interested()) {
      return;
    }
    emitDiagnosticEventWithTrust(
      {
        ...phase,
        type: "diagnostic.phase.completed",
        trace,
        details: phase.details ? { ...phase.details } : undefined,
      },
      true,
      // Measurements do not establish outbound trace state before dispatch.
      { queuedPhase: true },
    );
  };
}

/** Keeps trusted internal skill accounting alive when optional diagnostics are disabled. */
export function emitTrustedSkillUsedDiagnosticEvent(
  event: TrustedSkillUsedEventInput,
  privateData?: DiagnosticEventPrivateData,
) {
  const state = diagnosticEventsState;
  if (state.enabled) {
    emitDiagnosticEventWithTrust(event, true, { privateData });
    return;
  }
  const queued = {
    event: enrichDiagnosticEvent(state, event),
    metadata: { trusted: true },
    privateData,
    trustedListenersOnly: true,
  } satisfies QueuedDiagnosticEvent;
  if (state.asyncQueue.length >= MAX_ASYNC_DIAGNOSTIC_EVENTS) {
    noteAsyncDiagnosticDrop(state, queued);
    return;
  }
  if (!captureQueuedDiagnosticEvent(queued, state.trustedListeners.values())) {
    return;
  }
  state.asyncQueue.push(queued);
  scheduleAsyncDiagnosticDrain(state);
}

/** Emits a trusted diagnostic event with private listener-only payload data. */
export function emitTrustedDiagnosticEventWithPrivateData(
  event: DiagnosticEventInput,
  privateData?: DiagnosticEventPrivateData,
) {
  const coreModelRequestLifecycle = consumeCoreModelRequestLifecycleDiagnosticEvent(event);
  let sanitized = privateData;
  if (privateData && Object.hasOwn(privateData, "hostPluginId")) {
    // Host attribution is reserved for object-identity provenance, not private content.
    sanitized = { ...privateData };
    Reflect.deleteProperty(sanitized, "hostPluginId");
  }
  emitDiagnosticEventWithTrust(event, true, { coreModelRequestLifecycle, privateData: sanitized });
}

/** Emits a trusted canonical security event from core-owned enforcement boundaries. */
export function emitTrustedSecurityEvent(event: DiagnosticSecurityEventInput) {
  emitDiagnosticEventWithTrust(
    {
      type: "security.event",
      ...event,
      eventId: event.eventId ?? randomUUID(),
    },
    true,
    { allowSecurityEvent: true },
  );
}

/** Emits a trusted model failover diagnostic event. */
export function emitFailoverEvent(event: Omit<DiagnosticFailoverEvent, "seq" | "ts" | "type">) {
  emitTrustedDiagnosticEvent({
    type: "model.failover",
    ...event,
  });
}

/** SDK subscriptions belong to the registering instance, even if it drops the handle. */
function ownDiagnosticSubscription(unsubscribe: () => void): () => void {
  const instance = pluginInstanceInvocation.getStore()?.instance;
  if (!instance) {
    return unsubscribe;
  }
  let cleanup: (() => void) | undefined = unsubscribe;
  let unregister: (() => void) | undefined;
  const release = () => {
    unregister?.();
    unregister = undefined;
    cleanup?.();
    cleanup = undefined;
  };
  try {
    unregister = instance.lifecycle.onDispose(release);
  } catch (error) {
    release();
    throw error;
  }
  return release;
}

function registerDiagnosticEventListener<
  T,
  Interest extends InternalDiagnosticEventInterest<DiagnosticEventPayload["type"]>,
>(
  state: DiagnosticEventsGlobalState,
  listeners: Map<T, Interest | undefined>,
  listener: T,
  filter?: Interest,
): () => void {
  if (listeners.has(listener)) {
    updateInternalDiagnosticEventInterest(listeners.get(listener), -1);
  }
  listeners.set(listener, filter);
  updateInternalDiagnosticEventInterest(filter, 1);
  setInternalDiagnosticEventListenerCounts(state.listeners.size, state.trustedListeners.size);
  return ownDiagnosticSubscription(() => {
    const interest = listeners.get(listener);
    if (listeners.delete(listener)) {
      updateInternalDiagnosticEventInterest(interest, -1);
    }
    setInternalDiagnosticEventListenerCounts(state.listeners.size, state.trustedListeners.size);
  });
}

/** Subscribes to diagnostic events with dispatcher metadata. */
export function onInternalDiagnosticEvent(
  listener: DiagnosticEventListener,
  filter?: InternalDiagnosticEventInterest<DiagnosticEventPayload["type"]>,
): () => void {
  const state = diagnosticEventsState;
  return registerDiagnosticEventListener(state, state.listeners, listener, filter);
}

/** Subscribes to diagnostic events plus trusted private payload data. */
export function onTrustedInternalDiagnosticEvent(
  listener: TrustedDiagnosticEventListener,
  filter?: InternalDiagnosticEventInterest<DiagnosticEventPayload["type"]>,
  options?: TrustedDiagnosticEventListenerOptions,
): () => void {
  const state = diagnosticEventsState;
  return registerDiagnosticEventListener(state, state.trustedListeners, listener, {
    ...filter,
    includePrivateData: options?.includePrivateData,
  });
}

/** Subscribes to trusted metadata-only tool execution events, even when diagnostics are disabled. */
export function onTrustedToolExecutionEvent(
  listener: TrustedToolExecutionEventListener,
): () => void {
  return ownDiagnosticSubscription(
    registerListener(diagnosticEventsState.toolExecutionListeners, listener),
  );
}

/** Checks currently queued async diagnostic events without draining the queue. */
export function hasPendingInternalDiagnosticEvent(
  predicate: (event: DiagnosticEventPayload, metadata: DiagnosticEventMetadata) => boolean,
): boolean {
  const state = diagnosticEventsState;
  for (const entry of state.asyncQueue) {
    let event: DiagnosticEventPayload;
    try {
      event = cloneDiagnosticValueForListener(entry.event);
    } catch {
      continue;
    }
    if (predicate(event, createDiagnosticMetadataForListener(entry.metadata))) {
      return true;
    }
  }
  return false;
}

/** Subscribes to public untrusted diagnostic events only. */
export function onDiagnosticEvent(listener: (evt: DiagnosticEventPayload) => void): () => void {
  return onInternalDiagnosticEvent((event) => listener(event), {
    includeTrusted: [],
    exclude: PUBLIC_EXCLUDED_DIAGNOSTIC_EVENT_NAMES,
  });
}

/** Resets dispatcher state between tests. */
export function resetDiagnosticEventsForTest(): void {
  const state = diagnosticEventsState;
  state.enabled = true;
  state.seq = 0;
  state.listeners.clear();
  state.trustedListeners.clear();
  resetInternalDiagnosticEventListenerPresence();
  state.toolExecutionListeners.clear();
  state.toolExecutionSeq = 0;
  state.dispatchDepth = 0;
  state.asyncQueue = [];
  state.asyncDrainScheduled = false;
  state.asyncDroppedEvents = 0;
  state.asyncDroppedTrustedEvents = 0;
  state.asyncDroppedUntrustedEvents = 0;
  state.asyncDroppedPriorityEvents = 0;
  resetDiagnosticTracePropagationForTest();
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
