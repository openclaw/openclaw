import type { MemoryContentObject, MemoryTemporalMetadata } from "../types.js";

export type MemoryIngestionStage =
  | "normalize"
  | "extract"
  | "enrich"
  | "embed"
  | "graph"
  | "index"
  | "audit";

export type PipelineEventType =
  | "session.start"
  | "message.received"
  | "compaction.summary"
  | "ingest.normalize"
  | "ingest.extract"
  | "ingest.enrich"
  | "ingest.embed"
  | "ingest.graph"
  | "ingest.index"
  | "ingest.audit"
  | "query.request"
  | "query.response"
  | "context_pack.request"
  | "context_pack.response";

export type PipelineEventSource = "hook" | "tool" | "system" | "scheduler" | "manual";

export type PipelineEventEnvelope<TPayload = Record<string, unknown>> = {
  id: string;
  type: PipelineEventType;
  ts: string;
  source: PipelineEventSource;
  sessionKey?: string;
  runId?: string;
  traceId?: string;
  stage?: MemoryIngestionStage;
  payload: TPayload;
};

export type PipelineErrorCode =
  | "not_configured"
  | "invalid_input"
  | "adapter_unavailable"
  | "rate_limited"
  | "timeout"
  | "upstream_error"
  | "serialization_error"
  | "unknown";

export type PipelineError = {
  code: PipelineErrorCode;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
};

export type SessionStartEventPayload = {
  sessionKey: string;
  sessionId?: string;
  agentId?: string;
  channel?: string;
  startedAt: string;
};

export type MessageReceivedEventPayload = {
  sessionKey: string;
  sessionId?: string;
  messageId?: string;
  body: string;
  channel?: string;
  senderId?: string;
  receivedAt: string;
  temporal?: MemoryTemporalMetadata;
};

export type CompactionSummaryEventPayload = {
  sessionKey: string;
  sessionId?: string;
  summary: string;
  tokensBefore?: number;
  tokensAfter?: number;
  compactedAt: string;
};

export type IngestionStageResult = {
  stage: MemoryIngestionStage;
  ok: boolean;
  durationMs?: number;
  error?: PipelineError;
  output?: MemoryContentObject[];
};

export type IngestionPipelineContract = {
  stages: MemoryIngestionStage[];
  stageResults?: IngestionStageResult[];
  errors?: PipelineError[];
  startedAt?: string;
  completedAt?: string;
};
