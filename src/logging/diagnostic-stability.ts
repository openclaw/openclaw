// Diagnostic stability helpers compare diagnostic outputs across runs.
import {
  onDiagnosticEvent,
  type DiagnosticEventPayload,
  type DiagnosticMemoryUsage,
} from "../infra/diagnostic-events.js";

// Ring-buffer recorder for stability diagnostics and support-bundle snapshots.
const DEFAULT_DIAGNOSTIC_STABILITY_CAPACITY = 1000;
const DEFAULT_DIAGNOSTIC_STABILITY_LIMIT = 50;
export const MAX_DIAGNOSTIC_STABILITY_LIMIT = DEFAULT_DIAGNOSTIC_STABILITY_CAPACITY;
const LIVENESS_EVENT_LOOP_DELAY_WARN_MS = 1_000;
const CHANNEL_TURN_SLOW_LATENCY_WARN_MS = 10_000;

const SAFE_REASON_CODE = /^[A-Za-z0-9_.:-]{1,120}$/u;

/** Sanitized diagnostic event record retained in the stability ring buffer. */

type DiagnosticStabilityLatencyMetric = {
  count: number;
  slowCount: number;
  latestMs?: number;
  maxMs?: number;
  p50Ms?: number;
  p90Ms?: number;
  p95Ms?: number;
};

type DiagnosticStabilityChannelTurnLatencyMetricKey =
  | "messageAgeMs"
  | "receivedToTurnStartMs"
  | "startToDeliveryMs"
  | "startToCompletionMs";

type DiagnosticStabilityChannelTurnLatencyBottleneck = {
  phase: "ingress" | "queue" | "visible_delivery" | "completion";
  metric: DiagnosticStabilityChannelTurnLatencyMetricKey;
  maxMs: number;
  slowCount: number;
  count: number;
};

type DiagnosticStabilityChannelTurnLatencySummary = {
  messageAgeMs?: DiagnosticStabilityLatencyMetric;
  receivedToTurnStartMs?: DiagnosticStabilityLatencyMetric;
  startToDeliveryMs?: DiagnosticStabilityLatencyMetric;
  startToCompletionMs?: DiagnosticStabilityLatencyMetric;
  bottleneck?: DiagnosticStabilityChannelTurnLatencyBottleneck;
  recentSlow: Array<{
    seq: number;
    ts: number;
    channel?: string;
    turnId?: string;
    messageId?: string;
    metric: string;
    valueMs: number;
  }>;
};

type DiagnosticStabilityChannelTurnToolSummary = {
  called: number;
  results: number;
  failedResults: number;
  missingResults: number;
  slowResults: number;
  preDeliveryCalls: number;
  slowPreDeliveryResults: number;
  byTool: Record<
    string,
    {
      called: number;
      results: number;
      failedResults: number;
      missingResults: number;
      slowResults: number;
      preDeliveryCalls: number;
      slowPreDeliveryResults: number;
      maxDurationMs?: number;
    }
  >;
  recentSlow: Array<{
    seq: number;
    ts: number;
    channel?: string;
    turnId?: string;
    toolName?: string;
    durationMs: number;
  }>;
  recentFailures: Array<{
    seq: number;
    ts: number;
    channel?: string;
    turnId?: string;
    toolName?: string;
    reason?: string;
  }>;
  recentPreDeliverySlow: Array<{
    seq: number;
    ts: number;
    channel?: string;
    turnId?: string;
    toolName?: string;
    durationMs: number;
  }>;
};

type DiagnosticStabilitySessionAttentionSummary = {
  longRunning: number;
  stalled: number;
  stuck: number;
  recoveryRequested: number;
  recoveryCompleted: number;
  byClassification: Record<string, number>;
  byActiveWorkKind: Record<string, number>;
  recent: Array<{
    seq: number;
    ts: number;
    type: string;
    sessionKey?: string;
    state?: string;
    reason?: string;
    classification?: string;
    activeWorkKind?: string;
    toolName?: string;
    ageMs?: number;
    queueDepth?: number;
  }>;
};

type DiagnosticStabilityQueueLaneSummary = {
  enqueued: number;
  dequeued: number;
  slowDequeues: number;
  maxWaitMs?: number;
  maxQueueSize?: number;
};

type DiagnosticStabilityQueueSummary = {
  enqueued: number;
  dequeued: number;
  slowDequeues: number;
  maxWaitMs?: number;
  maxQueueSize?: number;
  byLane: Record<string, DiagnosticStabilityQueueLaneSummary>;
  recentSlow: Array<{
    seq: number;
    ts: number;
    lane: string;
    waitMs: number;
    queueSize?: number;
  }>;
};

export type DiagnosticStabilityRecommendation = {
  code:
    | "send_early_ack"
    | "inspect_gateway_ingress"
    | "clear_queue_pressure"
    | "inspect_blocked_tool"
    | "recover_stale_session"
    | "inspect_missing_delivery";
  priority: "high" | "medium" | "low";
  source: "channel_turns" | "sessions" | "queues";
  reason: string;
  count?: number;
  metric?: string;
  valueMs?: number;
  guidance: string;
};

export type DiagnosticStabilityHealthStatus = "ok" | "warning" | "degraded";

export type DiagnosticStabilityControlLaneReason =
  | "missing_visible_delivery"
  | "stale_ingress"
  | "queue_pressure"
  | "slow_visible_delivery"
  | "slow_pre_delivery_tool"
  | "blocked_tool_call"
  | "stale_session";

export type DiagnosticStabilityControlLaneHealth = {
  status: DiagnosticStabilityHealthStatus;
  reasons: DiagnosticStabilityControlLaneReason[];
  deliveryRequired: number;
  deliverySent: number;
  deliveryFailed: number;
  missingVisibleDelivery: number;
  slowIngress: number;
  slowQueue: number;
  slowVisibleDelivery: number;
  slowPreDeliveryTools: number;
  blockedSessions: number;
  stuckSessions: number;
  maxMessageAgeMs?: number;
  maxQueueWaitMs?: number;
  maxReceiveToStartMs?: number;
  maxStartToDeliveryMs?: number;
  guidance: string;
};

export type DiagnosticStabilityChannelTurnHealthIssue = {
  code:
    | "missing_visible_delivery"
    | "stale_message_at_receive"
    | "slow_receive_to_turn_start"
    | "slow_start_to_delivery"
    | "tool_result_failed"
    | "tool_result_missing"
    | "slow_tool_result"
    | "slow_tool_before_visible_delivery";
  level: Exclude<DiagnosticStabilityHealthStatus, "ok">;
  message: string;
  metric?: string;
  valueMs?: number;
  count?: number;
  guidance: string;
};

export type DiagnosticStabilityChannelTurnHealth = {
  status: DiagnosticStabilityHealthStatus;
  issues: DiagnosticStabilityChannelTurnHealthIssue[];
};

export type DiagnosticStabilityEventRecord = {
  seq: number;
  ts: number;
  type: DiagnosticEventPayload["type"];
  channel?: string;
  pluginId?: string;
  source?: string;
  target?: string;
  turnId?: string;
  sessionKey?: string;
  messageId?: string;
  surface?: string;
  action?: string;
  reason?: string;
  outcome?: string;
  mode?: string;
  level?: string;
  phase?: string;
  detector?: string;
  classification?: string;
  deliveryKind?: string;
  talkEventType?: string;
  transport?: string;
  brain?: string;
  toolName?: string;
  toolCallId?: string;
  activeWorkKind?: string;
  pairedToolName?: string;
  provider?: string;
  model?: string;
  durationMs?: number;
  isError?: boolean;
  requestBytes?: number;
  responseBytes?: number;
  timeToFirstByteMs?: number;
  resultCount?: number;
  commandLength?: number;
  exitCode?: number;
  timedOut?: boolean;
  final?: boolean;
  completionAllowed?: boolean;
  visibleDeliveryRequired?: boolean;
  visibleDeliverySent?: boolean;
  nativeMessageTimestamp?: number;
  messageReceivedAt?: number;
  messageAgeMs?: number;
  receivedToTurnStartMs?: number;
  startToDeliveryMs?: number;
  startToCompletionMs?: number;
  costUsd?: number;
  count?: number;
  bytes?: number;
  limitBytes?: number;
  thresholdBytes?: number;
  rssGrowthBytes?: number;
  windowMs?: number;
  eventLoopDelayP99Ms?: number;
  eventLoopDelayMaxMs?: number;
  eventLoopUtilization?: number;
  cpuCoreRatio?: number;
  ageMs?: number;
  queueDepth?: number;
  queueSize?: number;
  queueLength?: number;
  waitMs?: number;
  failureKind?: string;
  active?: number;
  waiting?: number;
  queued?: number;
  droppedEvents?: number;
  droppedTrustedEvents?: number;
  droppedUntrustedEvents?: number;
  droppedPriorityEvents?: number;
  maxQueueLength?: number;
  drainBatchSize?: number;
  webhooks?: {
    received: number;
    processed: number;
    errors: number;
  };
  memory?: DiagnosticMemoryUsage;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    promptTokens?: number;
    total?: number;
  };
  context?: {
    limit?: number;
    used?: number;
  };
};

/** Point-in-time stability snapshot with records and derived summaries. */
export type DiagnosticStabilitySnapshot = {
  generatedAt: string;
  capacity: number;
  count: number;
  dropped: number;
  firstSeq?: number;
  lastSeq?: number;
  events: DiagnosticStabilityEventRecord[];
  summary: {
    byType: Record<string, number>;
    memory?: {
      latest?: DiagnosticMemoryUsage;
      maxRssBytes?: number;
      maxHeapUsedBytes?: number;
      pressureCount: number;
    };
    payloadLarge?: {
      count: number;
      rejected: number;
      truncated: number;
      chunked: number;
      bySurface: Record<string, number>;
    };
    channelTurns?: {
      totalEvents: number;
      deliveryRequired: number;
      deliverySent: number;
      deliveryFailed: number;
      invalidCompletions: number;
      missingVisibleDelivery: number;
      byChannel: Record<
        string,
        {
          deliveryRequired: number;
          deliverySent: number;
          deliveryFailed: number;
          invalidCompletions: number;
          missingVisibleDelivery: number;
        }
      >;
      recentFailures: Array<{
        seq: number;
        ts: number;
        channel?: string;
        turnId?: string;
        sessionKey?: string;
        messageId?: string;
        reason?: string;
      }>;
      latency?: DiagnosticStabilityChannelTurnLatencySummary;
      tools?: DiagnosticStabilityChannelTurnToolSummary;
      health: DiagnosticStabilityChannelTurnHealth;
    };
    sessions?: {
      attention: DiagnosticStabilitySessionAttentionSummary;
    };
    queues?: DiagnosticStabilityQueueSummary;
    controlLane?: DiagnosticStabilityControlLaneHealth;
    recommendations?: DiagnosticStabilityRecommendation[];
  };
};

type DiagnosticStabilityQueryInput = {
  limit?: unknown;
  type?: unknown;
  sinceSeq?: unknown;
};

type NormalizedDiagnosticStabilityQuery = {
  limit: number;
  type: string | undefined;
  sinceSeq: number | undefined;
};

type DiagnosticStabilityState = {
  records: Array<DiagnosticStabilityEventRecord | undefined>;
  capacity: number;
  nextIndex: number;
  count: number;
  dropped: number;
  unsubscribe: (() => void) | null;
};

function createState(capacity = DEFAULT_DIAGNOSTIC_STABILITY_CAPACITY): DiagnosticStabilityState {
  return {
    records: Array.from<DiagnosticStabilityEventRecord | undefined>({ length: capacity }),
    capacity,
    nextIndex: 0,
    count: 0,
    dropped: 0,
    unsubscribe: null,
  };
}

function getDiagnosticStabilityState(): DiagnosticStabilityState {
  const globalStore = globalThis as typeof globalThis & {
    __openclawDiagnosticStabilityState?: DiagnosticStabilityState;
  };
  globalStore["__openclawDiagnosticStabilityState"] ??= createState();
  return globalStore["__openclawDiagnosticStabilityState"];
}

function copyMemory(memory: DiagnosticMemoryUsage): DiagnosticMemoryUsage {
  return { ...memory };
}

function copyReasonCode(reason: string | undefined): string | undefined {
  if (!reason || !SAFE_REASON_CODE.test(reason)) {
    return undefined;
  }
  return reason;
}

function assignReasonCode(
  record: DiagnosticStabilityEventRecord,
  reason: string | undefined,
): void {
  const reasonCode = copyReasonCode(reason);
  if (reasonCode) {
    record.reason = reasonCode;
  }
}

function summarizeChannelTurnTarget(target: string | undefined): string | undefined {
  const trimmed = target?.trim();
  if (!trimmed) {
    return undefined;
  }
  const prefixMatch = /^([A-Za-z][A-Za-z0-9_.-]{0,31}):/u.exec(trimmed);
  if (prefixMatch?.[1]) {
    return `kind:${prefixMatch[1].toLowerCase()}`;
  }
  if (/^-?\d+$/u.test(trimmed)) {
    return "kind:numeric-id";
  }
  if (/^[+@]/u.test(trimmed) || trimmed.includes("@")) {
    return "kind:contact";
  }
  return "kind:named";
}

function resolveDiagnosticLivenessRecordLevel(
  event: Extract<DiagnosticEventPayload, { type: "diagnostic.liveness.warning" }>,
): "warning" | "info" {
  const hasBlockingWork = event.waiting > 0 || event.queued > 0;
  const hasSustainedEventLoopDelay =
    (event.eventLoopDelayP99Ms ?? 0) >= LIVENESS_EVENT_LOOP_DELAY_WARN_MS;
  return hasBlockingWork || (event.active > 0 && hasSustainedEventLoopDelay) ? "warning" : "info";
}

function isRecord(
  record: DiagnosticStabilityEventRecord | undefined,
): record is DiagnosticStabilityEventRecord {
  return record !== undefined;
}

function sanitizeDiagnosticEvent(event: DiagnosticEventPayload): DiagnosticStabilityEventRecord {
  const record: DiagnosticStabilityEventRecord = {
    seq: event.seq,
    ts: event.ts,
    type: event.type,
  };

  switch (event.type) {
    case "model.usage":
      record.channel = event.channel;
      record.provider = event.provider;
      record.model = event.model;
      record.usage = { ...event.usage };
      record.context = event.context ? { ...event.context } : undefined;
      record.costUsd = event.costUsd;
      record.durationMs = event.durationMs;
      break;
    case "webhook.received":
      record.channel = event.channel;
      break;
    case "webhook.processed":
      record.channel = event.channel;
      record.durationMs = event.durationMs;
      break;
    case "webhook.error":
      record.channel = event.channel;
      break;
    case "message.queued":
      record.channel = event.channel;
      record.source = event.source;
      record.queueDepth = event.queueDepth;
      break;
    case "message.received":
      record.channel = event.channel;
      record.source = event.source;
      break;
    case "message.dispatch.started":
      record.channel = event.channel;
      record.source = event.source;
      break;
    case "message.dispatch.completed":
      record.channel = event.channel;
      record.source = event.source;
      record.durationMs = event.durationMs;
      record.outcome = event.outcome;
      assignReasonCode(record, event.reason);
      break;
    case "message.processed":
      record.channel = event.channel;
      record.durationMs = event.durationMs;
      record.outcome = event.outcome;
      assignReasonCode(record, event.reason);
      break;
    case "message.delivery.started":
      record.channel = event.channel;
      record.deliveryKind = event.deliveryKind;
      break;
    case "message.delivery.completed":
      record.channel = event.channel;
      record.deliveryKind = event.deliveryKind;
      record.durationMs = event.durationMs;
      record.resultCount = event.resultCount;
      record.outcome = "completed";
      break;
    case "message.delivery.error":
      record.channel = event.channel;
      record.deliveryKind = event.deliveryKind;
      record.durationMs = event.durationMs;
      record.outcome = "error";
      assignReasonCode(record, event.errorCategory);
      break;
    case "channel.turn.event":
      record.channel = event.channel;
      record.target = summarizeChannelTurnTarget(event.target);
      record.turnId = event.turnId;
      record.sessionKey = event.sessionKey;
      record.messageId = event.messageId;
      record.action = event.turnEventType;
      record.outcome = event.status;
      record.completionAllowed = event.completionAllowed;
      record.visibleDeliveryRequired = event.visibleDeliveryRequired;
      record.visibleDeliverySent = event.visibleDeliverySent;
      record.nativeMessageTimestamp = event.nativeMessageTimestamp;
      record.messageReceivedAt = event.messageReceivedAt;
      record.messageAgeMs = event.messageAgeMs;
      record.receivedToTurnStartMs = event.receivedToTurnStartMs;
      record.startToDeliveryMs = event.startToDeliveryMs;
      record.startToCompletionMs = event.startToCompletionMs;
      record.toolName = event.toolName;
      record.toolCallId = event.toolCallId;
      record.durationMs = event.durationMs;
      record.isError = event.isError;
      assignReasonCode(record, event.reason ?? event.deniedReason ?? event.errorCategory);
      break;
    case "talk.event":
      record.talkEventType = event.talkEventType;
      record.mode = event.mode;
      record.transport = event.transport;
      record.brain = event.brain;
      record.provider = event.provider;
      record.final = event.final;
      record.durationMs = event.durationMs;
      record.bytes = event.byteLength;
      break;
    case "session.state":
      record.outcome = event.state;
      assignReasonCode(record, event.reason);
      record.queueDepth = event.queueDepth;
      break;
    case "session.long_running":
    case "session.stalled":
    case "session.stuck":
      record.outcome = event.state;
      if (event.type === "session.stuck") {
        record.level = "warning";
      }
      assignReasonCode(record, event.reason);
      record.ageMs = event.ageMs;
      record.queueDepth = event.queueDepth;
      if (event.activeWorkKind) {
        record.activeWorkKind = event.activeWorkKind;
      }
      record.classification = event.classification;
      if (event.activeToolName) {
        record.toolName = event.activeToolName;
      }
      break;
    case "session.recovery.requested":
      record.outcome = event.state;
      record.action = event.allowActiveAbort ? "abort" : "recover";
      record.ageMs = event.ageMs;
      record.queueDepth = event.queueDepth;
      if (event.activeWorkKind) {
        record.activeWorkKind = event.activeWorkKind;
      }
      assignReasonCode(record, event.reason);
      break;
    case "session.recovery.completed":
      record.outcome = event.status;
      record.action = event.action;
      record.ageMs = event.ageMs;
      record.queueDepth = event.queueDepth;
      record.count = event.released;
      if (event.activeWorkKind) {
        record.activeWorkKind = event.activeWorkKind;
      }
      assignReasonCode(record, event.outcomeReason ?? event.reason);
      break;
    case "session.turn.created":
      record.source = event.agentId;
      record.channel = event.channel;
      record.outcome = event.trigger;
      break;
    case "queue.lane.enqueue":
      record.source = event.lane;
      record.queueSize = event.queueSize;
      break;
    case "queue.lane.dequeue":
      record.source = event.lane;
      record.queueSize = event.queueSize;
      record.waitMs = event.waitMs;
      break;
    case "run.attempt":
      record.count = event.attempt;
      break;
    case "run.progress":
      assignReasonCode(record, event.reason);
      break;
    case "context.assembled":
      record.channel = event.channel;
      record.provider = event.provider;
      record.model = event.model;
      record.count = event.messageCount;
      record.bytes = event.promptChars;
      record.context =
        event.contextTokenBudget !== undefined ? { limit: event.contextTokenBudget } : undefined;
      record.bytes = event.promptChars;
      break;
    case "diagnostic.heartbeat":
      record.webhooks = { ...event.webhooks };
      record.active = event.active;
      record.waiting = event.waiting;
      record.queued = event.queued;
      break;
    case "diagnostic.liveness.warning":
      record.level = resolveDiagnosticLivenessRecordLevel(event);
      record.durationMs = event.intervalMs;
      record.count = event.reasons.length;
      assignReasonCode(record, event.reasons[0]);
      record.eventLoopDelayP99Ms = event.eventLoopDelayP99Ms;
      record.eventLoopDelayMaxMs = event.eventLoopDelayMaxMs;
      record.eventLoopUtilization = event.eventLoopUtilization;
      record.cpuCoreRatio = event.cpuCoreRatio;
      record.active = event.active;
      record.waiting = event.waiting;
      record.queued = event.queued;
      record.phase = event.phase;
      if (event.activeWorkLabels?.length) {
        record.source = event.activeWorkLabels[0];
      } else if (event.queuedWorkLabels?.length) {
        record.source = event.queuedWorkLabels[0];
      }
      break;
    case "diagnostic.phase.completed":
      record.phase = event.name;
      record.durationMs = event.durationMs;
      record.cpuCoreRatio = event.cpuCoreRatio;
      break;
    case "tool.loop":
      record.toolName = event.toolName;
      record.level = event.level;
      record.action = event.action;
      record.detector = event.detector;
      record.count = event.count;
      record.pairedToolName = event.pairedToolName;
      break;
    case "tool.execution.started":
      record.toolName = event.toolName;
      record.source = event.toolSource;
      record.pluginId = event.toolOwner;
      break;
    case "tool.execution.completed":
      record.toolName = event.toolName;
      record.source = event.toolSource;
      record.pluginId = event.toolOwner;
      record.durationMs = event.durationMs;
      break;
    case "tool.execution.error":
      record.toolName = event.toolName;
      record.source = event.toolSource;
      record.pluginId = event.toolOwner;
      record.durationMs = event.durationMs;
      assignReasonCode(record, event.errorCategory);
      break;
    case "tool.execution.blocked":
      record.toolName = event.toolName;
      record.source = event.toolSource;
      record.pluginId = event.toolOwner;
      record.outcome = "blocked";
      assignReasonCode(record, event.deniedReason);
      break;
    case "skill.used":
      record.toolName = event.toolName;
      record.source = event.skillSource;
      record.action = event.activation;
      record.target = event.skillName;
      break;
    case "exec.process.completed":
      record.target = event.target;
      record.mode = event.mode;
      record.outcome = event.outcome;
      record.durationMs = event.durationMs;
      record.commandLength = event.commandLength;
      record.exitCode = event.exitCode;
      record.timedOut = event.timedOut;
      record.failureKind = event.failureKind;
      assignReasonCode(record, event.failureKind);
      break;
    case "run.started":
      record.provider = event.provider;
      record.model = event.model;
      record.channel = event.channel;
      break;
    case "run.completed":
      record.provider = event.provider;
      record.model = event.model;
      record.channel = event.channel;
      record.durationMs = event.durationMs;
      record.outcome = event.outcome;
      assignReasonCode(record, event.errorCategory);
      break;
    case "harness.run.started":
      record.source = event.harnessId;
      record.pluginId = event.pluginId;
      record.provider = event.provider;
      record.model = event.model;
      record.channel = event.channel;
      break;
    case "harness.run.completed":
      record.source = event.harnessId;
      record.pluginId = event.pluginId;
      record.provider = event.provider;
      record.model = event.model;
      record.channel = event.channel;
      record.durationMs = event.durationMs;
      record.outcome = event.outcome;
      record.count = event.itemLifecycle?.completedCount;
      break;
    case "harness.run.error":
      record.source = event.harnessId;
      record.pluginId = event.pluginId;
      record.provider = event.provider;
      record.model = event.model;
      record.channel = event.channel;
      record.durationMs = event.durationMs;
      record.outcome = "error";
      record.action = event.phase;
      assignReasonCode(record, event.errorCategory);
      break;
    case "model.call.started":
      record.provider = event.provider;
      record.model = event.model;
      break;
    case "model.call.completed":
      record.provider = event.provider;
      record.model = event.model;
      record.durationMs = event.durationMs;
      record.requestBytes = event.requestPayloadBytes;
      record.responseBytes = event.responseStreamBytes;
      record.timeToFirstByteMs = event.timeToFirstByteMs;
      break;
    case "model.call.error":
      record.provider = event.provider;
      record.model = event.model;
      record.durationMs = event.durationMs;
      record.requestBytes = event.requestPayloadBytes;
      record.responseBytes = event.responseStreamBytes;
      record.timeToFirstByteMs = event.timeToFirstByteMs;
      record.failureKind = event.failureKind;
      record.memory = event.memory ? copyMemory(event.memory) : undefined;
      assignReasonCode(record, event.errorCategory);
      break;
    case "log.record":
      record.level = event.level;
      record.source = event.loggerName;
      break;
    case "diagnostic.memory.sample":
      record.memory = copyMemory(event.memory);
      break;
    case "diagnostic.memory.pressure":
      record.level = event.level;
      assignReasonCode(record, event.reason);
      record.memory = copyMemory(event.memory);
      record.thresholdBytes = event.thresholdBytes;
      record.rssGrowthBytes = event.rssGrowthBytes;
      record.windowMs = event.windowMs;
      break;
    case "payload.large":
      record.surface = event.surface;
      record.action = event.action;
      record.bytes = event.bytes;
      record.limitBytes = event.limitBytes;
      record.count = event.count;
      record.channel = event.channel;
      record.pluginId = event.pluginId;
      assignReasonCode(record, event.reason);
      break;
    case "telemetry.exporter":
      record.source = event.exporter;
      record.target = event.signal;
      record.outcome = event.status;
      assignReasonCode(record, event.reason ?? event.errorCategory);
      break;
    case "diagnostic.async_queue.dropped":
      record.droppedEvents = event.droppedEvents;
      record.droppedTrustedEvents = event.droppedTrustedEvents;
      record.droppedUntrustedEvents = event.droppedUntrustedEvents;
      record.droppedPriorityEvents = event.droppedPriorityEvents;
      record.queueLength = event.queueLength;
      record.maxQueueLength = event.maxQueueLength;
      record.drainBatchSize = event.drainBatchSize;
      break;
    case "model.failover":
      record.provider = event.fromProvider;
      record.model = event.fromModel;
      assignReasonCode(record, event.reason);
      break;
  }

  return record;
}

function appendRecord(record: DiagnosticStabilityEventRecord): void {
  const state = getDiagnosticStabilityState();
  state.records[state.nextIndex] = record;
  state.nextIndex = (state.nextIndex + 1) % state.capacity;
  if (state.count < state.capacity) {
    state.count += 1;
    return;
  }
  state.dropped += 1;
}

function listRecords(): DiagnosticStabilityEventRecord[] {
  const state = getDiagnosticStabilityState();
  if (state.count === 0) {
    return [];
  }
  if (state.count < state.capacity) {
    return state.records.slice(0, state.count).filter(isRecord);
  }
  return [
    ...state.records.slice(state.nextIndex),
    ...state.records.slice(0, state.nextIndex),
  ].filter(isRecord);
}

function summarizeRecords(
  records: DiagnosticStabilityEventRecord[],
): DiagnosticStabilitySnapshot["summary"] {
  const byType: Record<string, number> = {};
  let latestMemory: DiagnosticMemoryUsage | undefined;
  let maxRssBytes: number | undefined;
  let maxHeapUsedBytes: number | undefined;
  let pressureCount = 0;
  const payloadLarge = {
    count: 0,
    rejected: 0,
    truncated: 0,
    chunked: 0,
    bySurface: {} as Record<string, number>,
  };
  const queues: DiagnosticStabilityQueueSummary = {
    enqueued: 0,
    dequeued: 0,
    slowDequeues: 0,
    byLane: {},
    recentSlow: [],
  };
  const sessionAttention: DiagnosticStabilitySessionAttentionSummary = {
    longRunning: 0,
    stalled: 0,
    stuck: 0,
    recoveryRequested: 0,
    recoveryCompleted: 0,
    byClassification: {},
    byActiveWorkKind: {},
    recent: [],
  };
  const channelTurns: Omit<
    NonNullable<DiagnosticStabilitySnapshot["summary"]["channelTurns"]>,
    "latency" | "tools"
  > & {
    latency: DiagnosticStabilityChannelTurnLatencySummary;
    tools: DiagnosticStabilityChannelTurnToolSummary;
  } = {
    totalEvents: 0,
    deliveryRequired: 0,
    deliverySent: 0,
    deliveryFailed: 0,
    invalidCompletions: 0,
    missingVisibleDelivery: 0,
    byChannel: {} as NonNullable<
      DiagnosticStabilitySnapshot["summary"]["channelTurns"]
    >["byChannel"],
    recentFailures: [] as NonNullable<
      DiagnosticStabilitySnapshot["summary"]["channelTurns"]
    >["recentFailures"],
    latency: {
      recentSlow: [],
    },
    tools: {
      called: 0,
      results: 0,
      failedResults: 0,
      missingResults: 0,
      slowResults: 0,
      preDeliveryCalls: 0,
      slowPreDeliveryResults: 0,
      byTool: {},
      recentSlow: [],
      recentFailures: [],
      recentPreDeliverySlow: [],
    },
    health: {
      status: "ok",
      issues: [],
    },
  };
  const channelTurnLatencySamples: Record<
    DiagnosticStabilityChannelTurnLatencyMetricKey,
    number[]
  > = {
    messageAgeMs: [],
    receivedToTurnStartMs: [],
    startToDeliveryMs: [],
    startToCompletionMs: [],
  };
  const terminalChannelTurnIds = new Set<string>();
  const channelTurnsRequiringVisibleDelivery = new Set<string>();
  const channelTurnsWithVisibleDelivery = new Set<string>();
  const activeChannelTurnTools = new Map<
    string,
    {
      seq: number;
      ts: number;
      channel?: string;
      turnId?: string;
      toolName?: string;
      preDelivery: boolean;
    }
  >();

  function pushChannelTurnHealthIssue(issue: DiagnosticStabilityChannelTurnHealthIssue): void {
    channelTurns.health.issues.push(issue);
    if (issue.level === "degraded") {
      channelTurns.health.status = "degraded";
    } else if (channelTurns.health.status === "ok") {
      channelTurns.health.status = "warning";
    }
  }

  function buildControlLaneHealth(): DiagnosticStabilityControlLaneHealth | undefined {
    const messageAge = channelTurns.latency.messageAgeMs;
    const receiveToStart = channelTurns.latency.receivedToTurnStartMs;
    const startToDelivery = channelTurns.latency.startToDeliveryMs;
    const blockedSessions = sessionAttention.byClassification.blocked_tool_call ?? 0;
    const stuckSessions = sessionAttention.stuck;
    const hasControlLaneEvidence =
      channelTurns.deliveryRequired > 0 ||
      channelTurns.deliveryFailed > 0 ||
      channelTurns.missingVisibleDelivery > 0 ||
      (messageAge?.slowCount ?? 0) > 0 ||
      (receiveToStart?.slowCount ?? 0) > 0 ||
      (startToDelivery?.slowCount ?? 0) > 0 ||
      channelTurns.tools.slowPreDeliveryResults > 0 ||
      queues.slowDequeues > 0 ||
      blockedSessions > 0 ||
      stuckSessions > 0;
    if (!hasControlLaneEvidence) {
      return undefined;
    }

    const reasons: DiagnosticStabilityControlLaneReason[] = [];
    const pushReason = (reason: DiagnosticStabilityControlLaneReason): void => {
      if (!reasons.includes(reason)) {
        reasons.push(reason);
      }
    };

    if (channelTurns.missingVisibleDelivery > 0) {
      pushReason("missing_visible_delivery");
    }
    if ((messageAge?.slowCount ?? 0) > 0) {
      pushReason("stale_ingress");
    }
    if ((receiveToStart?.slowCount ?? 0) > 0 || queues.slowDequeues > 0) {
      pushReason("queue_pressure");
    }
    if ((startToDelivery?.maxMs ?? 0) >= 20_000) {
      pushReason("slow_visible_delivery");
    }
    if (channelTurns.tools.slowPreDeliveryResults > 0) {
      pushReason("slow_pre_delivery_tool");
    }
    if (blockedSessions > 0 || sessionAttention.stalled > 0) {
      pushReason("blocked_tool_call");
    }
    if (stuckSessions > 0 || sessionAttention.recoveryRequested > 0) {
      pushReason("stale_session");
    }

    const degraded =
      channelTurns.missingVisibleDelivery > 0 ||
      (messageAge?.maxMs ?? 0) >= 60_000 ||
      (receiveToStart?.maxMs ?? 0) >= 60_000 ||
      (queues.maxWaitMs ?? 0) >= 60_000 ||
      blockedSessions > 0 ||
      stuckSessions > 0;
    const status: DiagnosticStabilityHealthStatus =
      degraded || reasons.length > 0 ? (degraded ? "degraded" : "warning") : "ok";
    const guidance =
      status === "degraded"
        ? "Direct-control lane is degraded; inspect delivery, queue/session pressure, or blocked tools before treating physical-control turns as healthy."
        : status === "warning"
          ? "Direct-control lane has latency pressure; send early acknowledgements and move long work to Tasks/TaskFlow."
          : "Direct-control lane has visible delivery proof and no current latency pressure.";

    return {
      status,
      reasons,
      deliveryRequired: channelTurns.deliveryRequired,
      deliverySent: channelTurns.deliverySent,
      deliveryFailed: channelTurns.deliveryFailed,
      missingVisibleDelivery: channelTurns.missingVisibleDelivery,
      slowIngress: messageAge?.slowCount ?? 0,
      slowQueue: Math.max(receiveToStart?.slowCount ?? 0, queues.slowDequeues),
      slowVisibleDelivery: startToDelivery?.slowCount ?? 0,
      slowPreDeliveryTools: channelTurns.tools.slowPreDeliveryResults,
      blockedSessions,
      stuckSessions,
      ...(messageAge?.maxMs !== undefined ? { maxMessageAgeMs: messageAge.maxMs } : {}),
      ...(queues.maxWaitMs !== undefined ? { maxQueueWaitMs: queues.maxWaitMs } : {}),
      ...(receiveToStart?.maxMs !== undefined ? { maxReceiveToStartMs: receiveToStart.maxMs } : {}),
      ...(startToDelivery?.maxMs !== undefined
        ? { maxStartToDeliveryMs: startToDelivery.maxMs }
        : {}),
      guidance,
    };
  }

  function buildRecommendations(): DiagnosticStabilityRecommendation[] {
    const recommendations: DiagnosticStabilityRecommendation[] = [];
    const pushRecommendation = (recommendation: DiagnosticStabilityRecommendation): void => {
      recommendations.push(recommendation);
    };

    if (channelTurns.missingVisibleDelivery > 0) {
      pushRecommendation({
        code: "inspect_missing_delivery",
        priority: "high",
        source: "channel_turns",
        reason: "missing_visible_delivery",
        count: channelTurns.missingVisibleDelivery,
        guidance:
          "Inspect the visible channel dispatch path; direct DMs must record delivery.sent before the turn is considered healthy.",
      });
    }

    const startToDeliveryMax = channelTurns.latency.startToDeliveryMs?.maxMs;
    if (
      channelTurns.tools.slowPreDeliveryResults > 0 ||
      (startToDeliveryMax !== undefined && startToDeliveryMax >= 20_000)
    ) {
      pushRecommendation({
        code: "send_early_ack",
        priority: "high",
        source: "channel_turns",
        reason:
          channelTurns.tools.slowPreDeliveryResults > 0
            ? "slow_tool_before_visible_delivery"
            : "slow_start_to_delivery",
        count:
          channelTurns.tools.slowPreDeliveryResults > 0
            ? channelTurns.tools.slowPreDeliveryResults
            : channelTurns.latency.startToDeliveryMs?.slowCount,
        metric:
          channelTurns.tools.slowPreDeliveryResults > 0
            ? "slowPreDeliveryResults"
            : "startToDeliveryMs",
        ...(startToDeliveryMax !== undefined ? { valueMs: startToDeliveryMax } : {}),
        guidance:
          "Send a short visible acknowledgement before long tool work, then continue the verified work through the normal turn or Tasks/TaskFlow.",
      });
    }

    const messageAgeMax = channelTurns.latency.messageAgeMs?.maxMs;
    if (messageAgeMax !== undefined && messageAgeMax >= CHANNEL_TURN_SLOW_LATENCY_WARN_MS) {
      pushRecommendation({
        code: "inspect_gateway_ingress",
        priority: messageAgeMax >= 60_000 ? "high" : "medium",
        source: "channel_turns",
        reason: "stale_message_at_receive",
        count: channelTurns.latency.messageAgeMs?.slowCount,
        metric: "messageAgeMs",
        valueMs: messageAgeMax,
        guidance:
          "Compare native channel send time with gateway receive time before blaming the agent; ingress may be delayed upstream of the turn.",
      });
    }

    const receiveToStartMax = channelTurns.latency.receivedToTurnStartMs?.maxMs;
    if (
      queues.slowDequeues > 0 ||
      (receiveToStartMax !== undefined && receiveToStartMax >= CHANNEL_TURN_SLOW_LATENCY_WARN_MS)
    ) {
      pushRecommendation({
        code: "clear_queue_pressure",
        priority: (queues.maxWaitMs ?? receiveToStartMax ?? 0) >= 60_000 ? "high" : "medium",
        source: queues.slowDequeues > 0 ? "queues" : "channel_turns",
        reason: queues.slowDequeues > 0 ? "slow_queue_dequeue" : "slow_receive_to_turn_start",
        count:
          queues.slowDequeues > 0
            ? queues.slowDequeues
            : channelTurns.latency.receivedToTurnStartMs?.slowCount,
        metric: queues.slowDequeues > 0 ? "waitMs" : "receivedToTurnStartMs",
        valueMs: queues.maxWaitMs ?? receiveToStartMax,
        guidance:
          "Inspect queue/session pressure, stale work, and overlapping background jobs; direct control messages should not wait behind long work.",
      });
    }

    const blockedToolCount = sessionAttention.byClassification.blocked_tool_call ?? 0;
    if (sessionAttention.stalled > 0 || blockedToolCount > 0) {
      pushRecommendation({
        code: "inspect_blocked_tool",
        priority: "high",
        source: "sessions",
        reason: blockedToolCount > 0 ? "blocked_tool_call" : "session_stalled",
        count: Math.max(sessionAttention.stalled, blockedToolCount),
        guidance:
          "Inspect the active tool and its timeout/result path before retrying broad work; keep direct chat responsive while the tool is isolated.",
      });
    }

    if (sessionAttention.stuck > 0 || sessionAttention.recoveryRequested > 0) {
      pushRecommendation({
        code: "recover_stale_session",
        priority: sessionAttention.stuck > 0 ? "high" : "medium",
        source: "sessions",
        reason: sessionAttention.stuck > 0 ? "session_stuck" : "session_recovery_requested",
        count: Math.max(sessionAttention.stuck, sessionAttention.recoveryRequested),
        guidance:
          "Use the official session recovery path and verify queued work is released without replaying stale user context.",
      });
    }

    return recommendations
      .toSorted((a, b) => {
        const priorityRank = { high: 0, medium: 1, low: 2 } as const;
        const priorityDelta = priorityRank[a.priority] - priorityRank[b.priority];
        if (priorityDelta !== 0) {
          return priorityDelta;
        }
        return a.code.localeCompare(b.code);
      })
      .slice(0, 8);
  }

  function summarizeQueueLane(lane: string | undefined): string {
    if (!lane) {
      return "unknown";
    }
    if (lane === "main") {
      return "main";
    }
    if (lane.startsWith("session:probe-")) {
      return "session-probe";
    }
    if (lane.startsWith("session:")) {
      return "session";
    }
    if (lane.startsWith("auth-probe:")) {
      return "auth-probe";
    }
    const prefix = lane.split(":", 1)[0] || "other";
    return SAFE_REASON_CODE.test(prefix) ? prefix : "other";
  }

  function resolveQueueLaneSummary(lane: string): DiagnosticStabilityQueueLaneSummary {
    queues.byLane[lane] ??= {
      enqueued: 0,
      dequeued: 0,
      slowDequeues: 0,
    };
    return queues.byLane[lane];
  }

  function recordQueueLaneEvent(record: DiagnosticStabilityEventRecord): void {
    if (record.type !== "queue.lane.enqueue" && record.type !== "queue.lane.dequeue") {
      return;
    }
    const lane = summarizeQueueLane(record.source);
    const laneSummary = resolveQueueLaneSummary(lane);
    if (record.type === "queue.lane.enqueue") {
      queues.enqueued += 1;
      laneSummary.enqueued += 1;
    } else {
      queues.dequeued += 1;
      laneSummary.dequeued += 1;
      if (typeof record.waitMs === "number" && Number.isFinite(record.waitMs)) {
        queues.maxWaitMs =
          queues.maxWaitMs === undefined
            ? record.waitMs
            : Math.max(queues.maxWaitMs, record.waitMs);
        laneSummary.maxWaitMs =
          laneSummary.maxWaitMs === undefined
            ? record.waitMs
            : Math.max(laneSummary.maxWaitMs, record.waitMs);
        if (record.waitMs >= CHANNEL_TURN_SLOW_LATENCY_WARN_MS) {
          queues.slowDequeues += 1;
          laneSummary.slowDequeues += 1;
          queues.recentSlow.push({
            seq: record.seq,
            ts: record.ts,
            lane,
            waitMs: record.waitMs,
            queueSize: record.queueSize,
          });
          if (queues.recentSlow.length > 10) {
            queues.recentSlow.shift();
          }
        }
      }
    }
    if (typeof record.queueSize === "number" && Number.isFinite(record.queueSize)) {
      queues.maxQueueSize =
        queues.maxQueueSize === undefined
          ? record.queueSize
          : Math.max(queues.maxQueueSize, record.queueSize);
      laneSummary.maxQueueSize =
        laneSummary.maxQueueSize === undefined
          ? record.queueSize
          : Math.max(laneSummary.maxQueueSize, record.queueSize);
    }
  }

  function recordSessionAttention(record: DiagnosticStabilityEventRecord): void {
    if (
      record.type !== "session.long_running" &&
      record.type !== "session.stalled" &&
      record.type !== "session.stuck" &&
      record.type !== "session.recovery.requested" &&
      record.type !== "session.recovery.completed"
    ) {
      return;
    }
    if (record.type === "session.long_running") {
      sessionAttention.longRunning += 1;
    } else if (record.type === "session.stalled") {
      sessionAttention.stalled += 1;
    } else if (record.type === "session.stuck") {
      sessionAttention.stuck += 1;
    } else if (record.type === "session.recovery.requested") {
      sessionAttention.recoveryRequested += 1;
    } else if (record.type === "session.recovery.completed") {
      sessionAttention.recoveryCompleted += 1;
    }
    const classification = record.classification ?? record.reason;
    if (classification) {
      sessionAttention.byClassification[classification] =
        (sessionAttention.byClassification[classification] ?? 0) + 1;
    }
    if (record.activeWorkKind) {
      sessionAttention.byActiveWorkKind[record.activeWorkKind] =
        (sessionAttention.byActiveWorkKind[record.activeWorkKind] ?? 0) + 1;
    }
    sessionAttention.recent.push({
      seq: record.seq,
      ts: record.ts,
      type: record.type,
      sessionKey: record.sessionKey,
      state: record.outcome,
      reason: record.reason,
      classification,
      activeWorkKind: record.activeWorkKind,
      toolName: record.toolName,
      ageMs: record.ageMs,
      queueDepth: record.queueDepth,
    });
    if (sessionAttention.recent.length > 10) {
      sessionAttention.recent.shift();
    }
  }

  function recordChannelTurnLatency(
    record: DiagnosticStabilityEventRecord,
    metric: DiagnosticStabilityChannelTurnLatencyMetricKey,
    valueMs: number | undefined,
  ): void {
    if (typeof valueMs !== "number" || !Number.isFinite(valueMs) || valueMs < 0) {
      return;
    }
    const latency = channelTurns.latency;
    channelTurnLatencySamples[metric].push(valueMs);
    const current = latency[metric];
    const slow = valueMs >= CHANNEL_TURN_SLOW_LATENCY_WARN_MS;
    latency[metric] = {
      count: (current?.count ?? 0) + 1,
      slowCount: (current?.slowCount ?? 0) + (slow ? 1 : 0),
      latestMs: valueMs,
      maxMs: current?.maxMs === undefined ? valueMs : Math.max(current.maxMs, valueMs),
    };
    if (slow) {
      latency.recentSlow.push({
        seq: record.seq,
        ts: record.ts,
        channel: record.channel,
        turnId: record.turnId,
        messageId: record.messageId,
        metric,
        valueMs,
      });
      if (latency.recentSlow.length > 10) {
        latency.recentSlow.shift();
      }
    }
  }

  function computePercentile(values: readonly number[], percentile: number): number | undefined {
    if (values.length === 0) {
      return undefined;
    }
    const sorted = values.toSorted((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
  }

  function resolveChannelTurnLatencyPhase(
    metric: DiagnosticStabilityChannelTurnLatencyMetricKey,
  ): DiagnosticStabilityChannelTurnLatencyBottleneck["phase"] {
    switch (metric) {
      case "messageAgeMs":
        return "ingress";
      case "receivedToTurnStartMs":
        return "queue";
      case "startToDeliveryMs":
        return "visible_delivery";
      case "startToCompletionMs":
        return "completion";
      default:
        return metric satisfies never;
    }
  }

  function finalizeChannelTurnLatencyMetrics(): void {
    let bottleneck: DiagnosticStabilityChannelTurnLatencyBottleneck | undefined;
    for (const [metric, values] of Object.entries(channelTurnLatencySamples) as Array<
      [DiagnosticStabilityChannelTurnLatencyMetricKey, number[]]
    >) {
      const current = channelTurns.latency[metric];
      if (!current) {
        continue;
      }
      channelTurns.latency[metric] = {
        ...current,
        p50Ms: computePercentile(values, 50),
        p90Ms: computePercentile(values, 90),
        p95Ms: computePercentile(values, 95),
      };
      const maxMs = current.maxMs;
      if (typeof maxMs !== "number" || !Number.isFinite(maxMs)) {
        continue;
      }
      if (
        !bottleneck ||
        current.slowCount > bottleneck.slowCount ||
        (current.slowCount === bottleneck.slowCount && maxMs > bottleneck.maxMs)
      ) {
        bottleneck = {
          phase: resolveChannelTurnLatencyPhase(metric),
          metric,
          maxMs,
          slowCount: current.slowCount,
          count: current.count,
        };
      }
    }
    if (bottleneck) {
      channelTurns.latency.bottleneck = bottleneck;
    }
  }

  function resolveToolSummaryEntry(toolName: string) {
    const tools = channelTurns.tools;
    tools.byTool[toolName] ??= {
      called: 0,
      results: 0,
      failedResults: 0,
      missingResults: 0,
      slowResults: 0,
      preDeliveryCalls: 0,
      slowPreDeliveryResults: 0,
    };
    return tools.byTool[toolName];
  }

  function recordChannelTurnToolEvent(record: DiagnosticStabilityEventRecord): void {
    if (record.action !== "tool.called" && record.action !== "tool.result") {
      return;
    }
    const tools = channelTurns.tools;
    const toolName = record.toolName ?? "unknown";
    const entry = resolveToolSummaryEntry(toolName);
    const toolCallKey =
      record.turnId && record.toolCallId ? `${record.turnId}:${record.toolCallId}` : undefined;
    if (record.action === "tool.called") {
      tools.called += 1;
      entry.called += 1;
      const preDelivery =
        record.turnId !== undefined &&
        channelTurnsRequiringVisibleDelivery.has(record.turnId) &&
        !channelTurnsWithVisibleDelivery.has(record.turnId);
      if (preDelivery) {
        tools.preDeliveryCalls += 1;
        entry.preDeliveryCalls += 1;
      }
      if (toolCallKey) {
        activeChannelTurnTools.set(toolCallKey, {
          seq: record.seq,
          ts: record.ts,
          channel: record.channel,
          turnId: record.turnId,
          toolName: record.toolName,
          preDelivery,
        });
      }
      return;
    }
    tools.results += 1;
    entry.results += 1;
    const pending = toolCallKey ? activeChannelTurnTools.get(toolCallKey) : undefined;
    if (toolCallKey) {
      activeChannelTurnTools.delete(toolCallKey);
    }
    if (typeof record.durationMs === "number" && Number.isFinite(record.durationMs)) {
      entry.maxDurationMs =
        entry.maxDurationMs === undefined
          ? record.durationMs
          : Math.max(entry.maxDurationMs, record.durationMs);
      if (record.durationMs >= CHANNEL_TURN_SLOW_LATENCY_WARN_MS) {
        tools.slowResults += 1;
        entry.slowResults += 1;
        tools.recentSlow.push({
          seq: record.seq,
          ts: record.ts,
          channel: record.channel,
          turnId: record.turnId,
          toolName: record.toolName,
          durationMs: record.durationMs,
        });
        if (tools.recentSlow.length > 10) {
          tools.recentSlow.shift();
        }
      }
      if (pending?.preDelivery && record.durationMs >= CHANNEL_TURN_SLOW_LATENCY_WARN_MS) {
        tools.slowPreDeliveryResults += 1;
        entry.slowPreDeliveryResults += 1;
        tools.recentPreDeliverySlow.push({
          seq: record.seq,
          ts: record.ts,
          channel: record.channel,
          turnId: record.turnId,
          toolName: record.toolName,
          durationMs: record.durationMs,
        });
        if (tools.recentPreDeliverySlow.length > 10) {
          tools.recentPreDeliverySlow.shift();
        }
      }
    }
    if (record.outcome === "failed" || record.isError === true) {
      tools.failedResults += 1;
      entry.failedResults += 1;
      tools.recentFailures.push({
        seq: record.seq,
        ts: record.ts,
        channel: record.channel,
        turnId: record.turnId,
        toolName: record.toolName,
        reason: record.reason,
      });
      if (tools.recentFailures.length > 10) {
        tools.recentFailures.shift();
      }
    }
  }

  function finalizeChannelTurnToolMetrics(): void {
    for (const pending of activeChannelTurnTools.values()) {
      if (!pending.turnId || !terminalChannelTurnIds.has(pending.turnId)) {
        continue;
      }
      const tools = channelTurns.tools;
      const toolName = pending.toolName ?? "unknown";
      const entry = resolveToolSummaryEntry(toolName);
      tools.missingResults += 1;
      entry.missingResults += 1;
      tools.recentFailures.push({
        seq: pending.seq,
        ts: pending.ts,
        channel: pending.channel,
        turnId: pending.turnId,
        toolName: pending.toolName,
        reason: "missing_tool_result",
      });
      if (tools.recentFailures.length > 10) {
        tools.recentFailures.shift();
      }
    }
  }

  for (const record of records) {
    byType[record.type] = (byType[record.type] ?? 0) + 1;
    if (record.memory) {
      latestMemory = record.memory;
      maxRssBytes =
        maxRssBytes === undefined
          ? record.memory.rssBytes
          : Math.max(maxRssBytes, record.memory.rssBytes);
      maxHeapUsedBytes =
        maxHeapUsedBytes === undefined
          ? record.memory.heapUsedBytes
          : Math.max(maxHeapUsedBytes, record.memory.heapUsedBytes);
    }
    if (record.type === "diagnostic.memory.pressure") {
      pressureCount += 1;
    }
    if (record.type === "payload.large") {
      payloadLarge.count += 1;
      if (record.action === "rejected") {
        payloadLarge.rejected += 1;
      } else if (record.action === "truncated") {
        payloadLarge.truncated += 1;
      } else if (record.action === "chunked") {
        payloadLarge.chunked += 1;
      }
      const surface = record.surface ?? "unknown";
      payloadLarge.bySurface[surface] = (payloadLarge.bySurface[surface] ?? 0) + 1;
    }
    recordQueueLaneEvent(record);
    recordSessionAttention(record);
    if (record.type === "channel.turn.event") {
      channelTurns.totalEvents += 1;
      const channel = record.channel ?? "unknown";
      channelTurns.byChannel[channel] ??= {
        deliveryRequired: 0,
        deliverySent: 0,
        deliveryFailed: 0,
        invalidCompletions: 0,
        missingVisibleDelivery: 0,
      };
      const channelSummary = channelTurns.byChannel[channel];
      if (record.action === "delivery.required") {
        channelTurns.deliveryRequired += 1;
        channelSummary.deliveryRequired += 1;
        if (record.turnId) {
          channelTurnsRequiringVisibleDelivery.add(record.turnId);
        }
      } else if (record.action === "delivery.sent") {
        channelTurns.deliverySent += 1;
        channelSummary.deliverySent += 1;
        if (record.turnId) {
          channelTurnsWithVisibleDelivery.add(record.turnId);
        }
      } else if (record.action === "delivery.failed") {
        channelTurns.deliveryFailed += 1;
        channelSummary.deliveryFailed += 1;
      }
      if (record.outcome === "invalid" || record.action === "turn.failed") {
        channelTurns.invalidCompletions += 1;
        channelSummary.invalidCompletions += 1;
      }
      if (record.action === "turn.completed" || record.action === "turn.failed") {
        if (record.turnId) {
          terminalChannelTurnIds.add(record.turnId);
        }
      }
      if (record.reason === "missing_visible_delivery") {
        channelTurns.missingVisibleDelivery += 1;
        channelSummary.missingVisibleDelivery += 1;
        channelTurns.recentFailures.push({
          seq: record.seq,
          ts: record.ts,
          channel: record.channel,
          turnId: record.turnId,
          sessionKey: record.sessionKey,
          messageId: record.messageId,
          reason: record.reason,
        });
        if (channelTurns.recentFailures.length > 10) {
          channelTurns.recentFailures.shift();
        }
      }
      recordChannelTurnLatency(record, "messageAgeMs", record.messageAgeMs);
      recordChannelTurnLatency(record, "receivedToTurnStartMs", record.receivedToTurnStartMs);
      recordChannelTurnLatency(record, "startToDeliveryMs", record.startToDeliveryMs);
      recordChannelTurnLatency(record, "startToCompletionMs", record.startToCompletionMs);
      recordChannelTurnToolEvent(record);
    }
  }
  finalizeChannelTurnLatencyMetrics();
  finalizeChannelTurnToolMetrics();

  if (channelTurns.missingVisibleDelivery > 0) {
    pushChannelTurnHealthIssue({
      code: "missing_visible_delivery",
      level: "degraded",
      message: "Direct channel turn required a visible reply but none was recorded.",
      count: channelTurns.missingVisibleDelivery,
      guidance:
        "Treat direct DM delivery as unhealthy; inspect message(action=send) dispatch before declaring the turn complete.",
    });
  }
  const messageAge = channelTurns.latency.messageAgeMs;
  const messageAgeMax = messageAge?.maxMs;
  if (
    messageAge !== undefined &&
    messageAgeMax !== undefined &&
    messageAgeMax >= CHANNEL_TURN_SLOW_LATENCY_WARN_MS
  ) {
    pushChannelTurnHealthIssue({
      code: "stale_message_at_receive",
      level: messageAgeMax >= 60_000 ? "degraded" : "warning",
      message: "A channel message was already stale when the runtime recorded it.",
      metric: "messageAgeMs",
      valueMs: messageAgeMax,
      count: messageAge.slowCount,
      guidance:
        "Compare native channel send time with runtime receive time; investigate webhook/polling/gateway ingress before blaming the agent turn.",
    });
  }
  const receiveToStart = channelTurns.latency.receivedToTurnStartMs;
  const receiveToStartMax = receiveToStart?.maxMs;
  if (
    receiveToStart !== undefined &&
    receiveToStartMax !== undefined &&
    receiveToStartMax >= CHANNEL_TURN_SLOW_LATENCY_WARN_MS
  ) {
    pushChannelTurnHealthIssue({
      code: "slow_receive_to_turn_start",
      level: receiveToStartMax >= 60_000 ? "degraded" : "warning",
      message: "A received channel message waited too long before a turn started.",
      metric: "receivedToTurnStartMs",
      valueMs: receiveToStartMax,
      count: receiveToStart.slowCount,
      guidance:
        "Inspect queue/session pressure and background work; direct control messages should get a fast turn or cancellation path.",
    });
  }
  const startToDelivery = channelTurns.latency.startToDeliveryMs;
  const startToDeliveryMax = startToDelivery?.maxMs;
  if (
    startToDelivery !== undefined &&
    startToDeliveryMax !== undefined &&
    startToDeliveryMax >= 20_000
  ) {
    pushChannelTurnHealthIssue({
      code: "slow_start_to_delivery",
      level: "warning",
      message: "A channel turn took too long to produce visible delivery after starting.",
      metric: "startToDeliveryMs",
      valueMs: startToDeliveryMax,
      count: startToDelivery.slowCount,
      guidance:
        "Use an early visible acknowledgement before long tool work; keep final delivery after verification.",
    });
  }
  if (channelTurns.tools.failedResults > 0) {
    pushChannelTurnHealthIssue({
      code: "tool_result_failed",
      level: "warning",
      message: "A channel turn tool returned a failed result.",
      count: channelTurns.tools.failedResults,
      guidance:
        "Inspect the failed tool before retrying the whole turn; keep the user-facing result grounded in verified tool outcomes.",
    });
  }
  if (channelTurns.tools.missingResults > 0) {
    pushChannelTurnHealthIssue({
      code: "tool_result_missing",
      level: "warning",
      message: "A channel turn completed with a started tool that had no recorded result.",
      count: channelTurns.tools.missingResults,
      guidance:
        "Check whether the run aborted, timed out, or lost tool-result events before considering the turn complete.",
    });
  }
  if (channelTurns.tools.slowResults > 0) {
    pushChannelTurnHealthIssue({
      code: "slow_tool_result",
      level: "warning",
      message: "A channel turn tool result exceeded the slow latency threshold.",
      count: channelTurns.tools.slowResults,
      guidance:
        "Move long work to Tasks/TaskFlow and send an early acknowledgement so direct chat remains responsive.",
    });
  }
  if (channelTurns.tools.slowPreDeliveryResults > 0) {
    pushChannelTurnHealthIssue({
      code: "slow_tool_before_visible_delivery",
      level: "warning",
      message: "A direct channel turn ran slow tool work before visible delivery.",
      count: channelTurns.tools.slowPreDeliveryResults,
      guidance:
        "Send a short visible acknowledgement before long tools, then continue the verified work in the same turn or a TaskFlow.",
    });
  }

  const controlLane = buildControlLaneHealth();
  const recommendations = buildRecommendations();

  return {
    byType,
    ...(latestMemory || pressureCount > 0
      ? {
          memory: {
            latest: latestMemory,
            maxRssBytes,
            maxHeapUsedBytes,
            pressureCount,
          },
        }
      : {}),
    ...(payloadLarge.count > 0 ? { payloadLarge } : {}),
    ...(channelTurns.totalEvents > 0 ? { channelTurns } : {}),
    ...(sessionAttention.longRunning > 0 ||
    sessionAttention.stalled > 0 ||
    sessionAttention.stuck > 0 ||
    sessionAttention.recoveryRequested > 0 ||
    sessionAttention.recoveryCompleted > 0
      ? { sessions: { attention: sessionAttention } }
      : {}),
    ...(queues.enqueued > 0 || queues.dequeued > 0 ? { queues } : {}),
    ...(controlLane ? { controlLane } : {}),
    ...(recommendations.length > 0 ? { recommendations } : {}),
  };
}

function selectRecords(
  records: DiagnosticStabilityEventRecord[],
  options?: {
    limit?: number;
    type?: string;
    sinceSeq?: number;
  },
): {
  filtered: DiagnosticStabilityEventRecord[];
  events: DiagnosticStabilityEventRecord[];
} {
  const { limit, type, sinceSeq } = normalizeDiagnosticStabilityQuery(options);
  const filtered = records.filter((record) => {
    if (type && record.type !== type) {
      return false;
    }
    if (sinceSeq !== undefined && record.seq <= sinceSeq) {
      return false;
    }
    return true;
  });
  return {
    filtered,
    events: filtered.slice(Math.max(0, filtered.length - limit)),
  };
}

function parseOptionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return parsed;
}

function parseOptionalType(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("type must be a non-empty string");
  }
  return value.trim();
}

function normalizeLimit(limit: unknown, defaultLimit = DEFAULT_DIAGNOSTIC_STABILITY_LIMIT): number {
  const parsed = parseOptionalNonNegativeInteger(limit, "limit");
  if (parsed === undefined) {
    return defaultLimit;
  }
  if (parsed < 1 || parsed > MAX_DIAGNOSTIC_STABILITY_LIMIT) {
    throw new Error(`limit must be between 1 and ${MAX_DIAGNOSTIC_STABILITY_LIMIT}`);
  }
  return parsed;
}

/** Normalizes user-facing snapshot query options. */
export function normalizeDiagnosticStabilityQuery(
  input: DiagnosticStabilityQueryInput = {},
  options?: { defaultLimit?: number },
): NormalizedDiagnosticStabilityQuery {
  return {
    limit: normalizeLimit(input.limit, options?.defaultLimit),
    type: parseOptionalType(input.type),
    sinceSeq: parseOptionalNonNegativeInteger(input.sinceSeq, "sinceSeq"),
  };
}

/** Starts the process-wide diagnostic event recorder if it is not already active. */
export function startDiagnosticStabilityRecorder(): void {
  const state = getDiagnosticStabilityState();
  if (state.unsubscribe) {
    return;
  }
  state.unsubscribe = onDiagnosticEvent((event) => {
    appendRecord(sanitizeDiagnosticEvent(event));
  });
}

/** Stops the process-wide diagnostic event recorder. */
export function stopDiagnosticStabilityRecorder(): void {
  const state = getDiagnosticStabilityState();
  state.unsubscribe?.();
  state.unsubscribe = null;
}

/** Returns a sanitized stability snapshot from the process-wide ring buffer. */
export function getDiagnosticStabilitySnapshot(options?: {
  limit?: number;
  type?: string;
  sinceSeq?: number;
}): DiagnosticStabilitySnapshot {
  const state = getDiagnosticStabilityState();
  const { filtered, events } = selectRecords(listRecords(), options);
  return {
    generatedAt: new Date().toISOString(),
    capacity: state.capacity,
    count: filtered.length,
    dropped: state.dropped,
    firstSeq: filtered[0]?.seq,
    lastSeq: filtered.at(-1)?.seq,
    events,
    summary: summarizeRecords(filtered),
  };
}

/** Applies filtering/limits to an existing snapshot without mutating its source records. */
export function selectDiagnosticStabilitySnapshot(
  snapshot: DiagnosticStabilitySnapshot,
  options?: {
    limit?: number;
    type?: string;
    sinceSeq?: number;
  },
): DiagnosticStabilitySnapshot {
  const { filtered, events } = selectRecords(snapshot.events, options);
  return {
    ...snapshot,
    count: filtered.length,
    firstSeq: filtered[0]?.seq,
    lastSeq: filtered.at(-1)?.seq,
    events,
    summary: summarizeRecords(filtered),
  };
}

/** Resets recorder state and subscriptions for isolated tests. */
export function resetDiagnosticStabilityRecorderForTest(): void {
  const state = getDiagnosticStabilityState();
  state.unsubscribe?.();
  const next = createState(state.capacity);
  const globalStore = globalThis as typeof globalThis & {
    __openclawDiagnosticStabilityState?: DiagnosticStabilityState;
  };
  globalStore["__openclawDiagnosticStabilityState"] = next;
}
