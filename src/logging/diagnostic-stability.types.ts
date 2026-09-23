import type { DiagnosticEventPayload, DiagnosticMemoryUsage } from "../infra/diagnostic-events.js";

/** Sanitized diagnostic event record retained in the stability ring buffer. */
export type DiagnosticStabilityEventRecord = {
  seq: number;
  ts: number;
  type: DiagnosticEventPayload["type"];
  channel?: string;
  pluginId?: string;
  source?: string;
  target?: string;
  surface?: string;
  action?: string;
  reason?: string;
  errorCategory?: string;
  outcome?: string;
  mode?: string;
  level?: string;
  phase?: string;
  detector?: string;
  deliveryKind?: string;
  talkEventType?: string;
  transport?: string;
  brain?: string;
  toolName?: string;
  approvalId?: string;
  activeWorkKind?: string;
  pairedToolName?: string;
  provider?: string;
  model?: string;
  durationMs?: number;
  requestBytes?: number;
  responseBytes?: number;
  timeToFirstByteMs?: number;
  resultCount?: number;
  commandLength?: number;
  exitCode?: number;
  timedOut?: boolean;
  final?: boolean;
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
  };
};

export type DiagnosticExporterHealthUpdate = {
  signal: "traces" | "metrics" | "logs";
  transport: string;
  endpointMode?: "configured" | "default_endpoint";
  status: "started" | "failure" | "recovered" | "dropped";
  reason?:
    | "configured"
    | "default_endpoint"
    | "export_failed"
    | "handler_failed"
    | "emit_failed"
    | "queue_full"
    | "shutdown_failed"
    | "start_failed"
    | "unsupported_protocol";
  errorCategory?: string;
};
