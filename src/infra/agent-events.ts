import type { VerboseLevel } from "../auto-reply/thinking.js";

export type AgentEventStream = "lifecycle" | "tool" | "assistant" | "error" | (string & {});

export type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: AgentEventStream;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
};

export type AgentRunContext = {
  sessionKey?: string;
  verboseLevel?: VerboseLevel;
  isHeartbeat?: boolean;
};

// Keep per-run counters so streams stay strictly monotonic per runId.
const seqByRun = new Map<string, number>();
const listeners = new Set<(evt: AgentEventPayload) => void>();
const runContextById = new Map<string, AgentRunContext>();

export function registerAgentRunContext(runId: string, context: AgentRunContext) {
  if (!runId) return;
  const existing = runContextById.get(runId);
  if (!existing) {
    runContextById.set(runId, { ...context });
    return;
  }
  if (context.sessionKey && existing.sessionKey !== context.sessionKey) {
    existing.sessionKey = context.sessionKey;
  }
  if (context.verboseLevel && existing.verboseLevel !== context.verboseLevel) {
    existing.verboseLevel = context.verboseLevel;
  }
  if (context.isHeartbeat !== undefined && existing.isHeartbeat !== context.isHeartbeat) {
    existing.isHeartbeat = context.isHeartbeat;
  }
}

export function getAgentRunContext(runId: string) {
  return runContextById.get(runId);
}

export function clearAgentRunContext(runId: string) {
  runContextById.delete(runId);
}

export function resetAgentRunContextForTest() {
  runContextById.clear();
}

export function emitAgentEvent(event: Omit<AgentEventPayload, "seq" | "ts">) {
  const nextSeq = (seqByRun.get(event.runId) ?? 0) + 1;
  seqByRun.set(event.runId, nextSeq);
  const context = runContextById.get(event.runId);
  const sessionKey =
    typeof event.sessionKey === "string" && event.sessionKey.trim()
      ? event.sessionKey
      : context?.sessionKey;
  const enriched: AgentEventPayload = {
    ...event,
    sessionKey,
    seq: nextSeq,
    ts: Date.now(),
  };
  for (const listener of listeners) {
    try {
      listener(enriched);
    } catch {
      /* ignore */
    }
  }
}

export function onAgentEvent(listener: (evt: AgentEventPayload) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ============================================================================
// Agent Metrics - Track compaction, timeouts, resets, and context usage
// ============================================================================

export interface AgentMetrics {
  /** Number of compaction operations performed */
  compactionCount: number;
  /** Duration of last compaction in milliseconds */
  lastCompactionDurationMs?: number;
  /** Timestamp of last compaction */
  lastCompactionAt?: number;
  /** Number of timeout events */
  timeoutCount: number;
  /** Number of session resets */
  resetCount: number;
  /** Current context usage */
  contextUsage: {
    current: number;
    max: number;
    percentage: number;
  };
  /** Timestamp of last activity */
  lastActivity: number;
  /** Current agent state */
  state: "idle" | "processing" | "streaming" | "compacting";
}

const metricsStore = new Map<string, AgentMetrics>();

function getDefaultMetrics(): AgentMetrics {
  return {
    compactionCount: 0,
    timeoutCount: 0,
    resetCount: 0,
    contextUsage: { current: 0, max: 0, percentage: 0 },
    lastActivity: Date.now(),
    state: "idle",
  };
}

/**
 * Update metrics for an agent.
 * @param agentId - The agent ID (e.g., "liam-telegram")
 * @param update - Partial metrics to update
 */
export function updateAgentMetrics(agentId: string, update: Partial<AgentMetrics>): void {
  const existing = metricsStore.get(agentId) ?? getDefaultMetrics();
  const updated: AgentMetrics = {
    ...existing,
    ...update,
    lastActivity: Date.now(),
  };
  // Merge contextUsage if provided
  if (update.contextUsage) {
    updated.contextUsage = { ...existing.contextUsage, ...update.contextUsage };
  }
  metricsStore.set(agentId, updated);
}

/**
 * Get metrics for an agent.
 * @param agentId - The agent ID
 * @returns The agent metrics, or undefined if not tracked
 */
export function getAgentMetrics(agentId: string): AgentMetrics | undefined {
  return metricsStore.get(agentId);
}

/**
 * Get metrics for all tracked agents.
 * @returns Map of agent ID to metrics
 */
export function getAllAgentMetrics(): Map<string, AgentMetrics> {
  return new Map(metricsStore);
}

/**
 * Record a compaction event.
 * @param agentId - The agent ID
 * @param durationMs - Duration of the compaction in milliseconds
 */
export function recordCompaction(agentId: string, durationMs: number): void {
  const existing = metricsStore.get(agentId) ?? getDefaultMetrics();
  updateAgentMetrics(agentId, {
    compactionCount: existing.compactionCount + 1,
    lastCompactionDurationMs: durationMs,
    lastCompactionAt: Date.now(),
  });
}

/**
 * Record a timeout event.
 * @param agentId - The agent ID
 */
export function recordTimeout(agentId: string): void {
  const existing = metricsStore.get(agentId) ?? getDefaultMetrics();
  updateAgentMetrics(agentId, {
    timeoutCount: existing.timeoutCount + 1,
  });
}

/**
 * Record a session reset event.
 * @param agentId - The agent ID
 */
export function recordSessionReset(agentId: string): void {
  const existing = metricsStore.get(agentId) ?? getDefaultMetrics();
  updateAgentMetrics(agentId, {
    resetCount: existing.resetCount + 1,
  });
}

/**
 * Update context usage for an agent.
 * @param agentId - The agent ID
 * @param current - Current token count
 * @param max - Maximum token count
 */
export function updateContextUsage(agentId: string, current: number, max: number): void {
  const percentage = max > 0 ? Math.round((current / max) * 100) : 0;
  updateAgentMetrics(agentId, {
    contextUsage: { current, max, percentage },
  });
}

/**
 * Set the agent state.
 * @param agentId - The agent ID
 * @param state - The new state
 */
export function setAgentState(agentId: string, state: AgentMetrics["state"]): void {
  updateAgentMetrics(agentId, { state });
}

/**
 * Reset metrics for testing.
 */
export function resetAgentMetricsForTest(): void {
  metricsStore.clear();
}
