import { emitAgentEvent, type AgentEventPayload } from "./agent-events.js";

/**
 * Extended lifecycle phases for agent runtime monitoring.
 * These supplement the existing phases (start, end, error) with more granular visibility.
 */
export type AgentLifecyclePhase =
  | "start"
  | "end"
  | "error"
  | "heartbeat"
  | "checkpoint"
  | "timeout"
  | "stalled"
  | "recovered";

/**
 * Structured metadata for agent lifecycle events.
 * Provides consistent logging fields across all lifecycle phases.
 */
export interface AgentLifecycleMetadata {
  /** Unique identifier for the agent run */
  runId: string;
  /** Session key for correlation */
  sessionKey?: string;
  /** Agent ID if available */
  agentId?: string;
  /** Timestamp when the run started */
  startedAt?: number;
  /** Current timestamp */
  timestamp: number;
  /** Duration in milliseconds (for end/error phases) */
  durationMs?: number;
  /** Error information if applicable */
  error?: {
    type: string;
    message: string;
    stack?: string;
  };
  /** Additional context-specific data */
  context?: Record<string, unknown>;
}

/**
 * Emit a lifecycle event with structured metadata.
 * This provides consistent logging and monitoring across agent runs.
 */
export function emitLifecycleEvent(
  phase: AgentLifecyclePhase,
  metadata: AgentLifecycleMetadata,
): void {
  // Destructure to avoid duplicating runId/sessionKey in data object
  const { runId, sessionKey, ...rest } = metadata;
  emitAgentEvent({
    runId,
    stream: "lifecycle",
    data: {
      phase,
      ...rest,
    },
    sessionKey,
  });
}

/**
 * Create structured metadata for a lifecycle event.
 * Ensures consistent fields across all event types.
 */
export function createLifecycleMetadata(params: {
  runId: string;
  sessionKey?: string;
  agentId?: string;
  startedAt?: number;
}): AgentLifecycleMetadata {
  return {
    runId: params.runId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    startedAt: params.startedAt,
    timestamp: Date.now(),
  };
}

/**
 * Emit a heartbeat event for long-running agent operations.
 * Helps detect stalled or stuck agents.
 */
export function emitHeartbeat(params: {
  runId: string;
  sessionKey?: string;
  agentId?: string;
  startedAt: number;
  checkpoint?: string;
}): void {
  emitLifecycleEvent("heartbeat", {
    runId: params.runId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    startedAt: params.startedAt,
    timestamp: Date.now(),
    context: params.checkpoint ? { checkpoint: params.checkpoint } : undefined,
  });
}

/**
 * Emit a checkpoint event during agent execution.
 * Provides visibility into long-running operations.
 */
export function emitCheckpoint(params: {
  runId: string;
  sessionKey?: string;
  agentId?: string;
  startedAt: number;
  checkpoint: string;
  progress?: string;
}): void {
  emitLifecycleEvent("checkpoint", {
    runId: params.runId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    startedAt: params.startedAt,
    timestamp: Date.now(),
    context: {
      checkpoint: params.checkpoint,
      progress: params.progress,
    },
  });
}

/**
 * Emit a timeout event when agent execution exceeds expected duration.
 */
export function emitTimeout(params: {
  runId: string;
  sessionKey?: string;
  agentId?: string;
  startedAt: number;
  timeoutMs: number;
  lastCheckpoint?: string;
}): void {
  const durationMs = Date.now() - params.startedAt;
  emitLifecycleEvent("timeout", {
    runId: params.runId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    startedAt: params.startedAt,
    timestamp: Date.now(),
    durationMs,
    error: {
      type: "TIMEOUT",
      message: `Agent execution timed out after ${durationMs}ms (limit: ${params.timeoutMs}ms)`,
    },
    context: params.lastCheckpoint ? { lastCheckpoint: params.lastCheckpoint } : undefined,
  });
}

/**
 * Emit a stalled event when agent appears stuck.
 */
export function emitStalled(params: {
  runId: string;
  sessionKey?: string;
  agentId?: string;
  startedAt: number;
  stalledDurationMs: number;
  lastActivity?: string;
}): void {
  emitLifecycleEvent("stalled", {
    runId: params.runId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    startedAt: params.startedAt,
    timestamp: Date.now(),
    durationMs: params.stalledDurationMs,
    context: params.lastActivity ? { lastActivity: params.lastActivity } : undefined,
  });
}

/**
 * Emit a recovered event when stalled agent resumes.
 */
export function emitRecovered(params: {
  runId: string;
  sessionKey?: string;
  agentId?: string;
  startedAt: number;
  recoveredAt: number;
  wasStalledForMs: number;
}): void {
  const durationMs = params.recoveredAt - params.startedAt;
  emitLifecycleEvent("recovered", {
    runId: params.runId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    startedAt: params.startedAt,
    timestamp: params.recoveredAt,
    durationMs,
    context: {
      wasStalledForMs: params.wasStalledForMs,
    },
  });
}

/**
 * Extract structured error information from an error object.
 */
export function extractErrorInfo(error: unknown): { type: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      type: error.name || "Error",
      message: error.message,
      stack: error.stack,
    };
  }
  // Handle plain objects with name/message properties
  if (error && typeof error === "object" && "name" in error && "message" in error) {
    const err = error as { name?: unknown; message?: unknown; stack?: unknown };
    return {
      type: typeof err.name === "string" && err.name ? err.name : "UnknownError",
      message: typeof err.message === "string" && err.message ? err.message : String(error),
      stack: typeof err.stack === "string" ? err.stack : undefined,
    };
  }
  return {
    type: "UnknownError",
    message: String(error),
  };
}
