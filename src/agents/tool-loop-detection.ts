import type { SessionState } from "../logging/diagnostic-session-state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agents/loop-detection");

export type LoopDetectionResult =
  | { stuck: false }
  | { stuck: true; level: "warning" | "critical"; message: string };

export const TOOL_CALL_HISTORY_SIZE = 30;
export const WARNING_THRESHOLD = 10;
export const CRITICAL_THRESHOLD = 20;

/**
 * Hash a tool call for pattern matching.
 * Uses tool name + deterministic JSON stringification of params.
 */
export function hashToolCall(toolName: string, params: unknown): string {
  try {
    const paramsStr = stableStringify(params);
    return `${toolName}:${paramsStr}`;
  } catch {
    return `${toolName}:${String(params)}`;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).toSorted();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * Detect if an agent is stuck in a repetitive tool call loop.
 * Checks if the same tool+params combination has been called excessively.
 */
export function detectToolCallLoop(
  state: SessionState,
  toolName: string,
  params: unknown,
): LoopDetectionResult {
  const history = state.toolCallHistory ?? [];
  const currentHash = hashToolCall(toolName, params);

  // Count occurrences of this exact call in recent history
  const recentCount = history.filter(
    (h) => h.toolName === toolName && h.argsHash === currentHash,
  ).length;

  if (recentCount >= CRITICAL_THRESHOLD) {
    log.error(
      `Critical loop detected: ${toolName} called ${recentCount} times with identical arguments`,
    );
    return {
      stuck: true,
      level: "critical",
      message: `CRITICAL: Called ${toolName} with identical arguments ${recentCount} times. This appears to be a stuck polling loop. Session execution blocked to prevent resource waste.`,
    };
  }

  if (recentCount >= WARNING_THRESHOLD) {
    log.warn(`Loop warning: ${toolName} called ${recentCount} times with identical arguments`);
    return {
      stuck: true,
      level: "warning",
      message: `WARNING: You have called ${toolName} ${recentCount} times with identical arguments and no progress. Stop polling and either (1) increase wait time between checks, or (2) report the task as failed if the process is stuck.`,
    };
  }

  return { stuck: false };
}

/**
 * Record a tool call in the session's history for loop detection.
 * Maintains sliding window of last N calls.
 */
export function recordToolCall(state: SessionState, toolName: string, params: unknown): void {
  if (!state.toolCallHistory) {
    state.toolCallHistory = [];
  }

  state.toolCallHistory.push({
    toolName,
    argsHash: hashToolCall(toolName, params),
    timestamp: Date.now(),
  });

  if (state.toolCallHistory.length > TOOL_CALL_HISTORY_SIZE) {
    state.toolCallHistory.shift();
  }
}

/**
 * Get current tool call statistics for a session (for debugging/monitoring).
 */
export function getToolCallStats(state: SessionState): {
  totalCalls: number;
  uniquePatterns: number;
  mostFrequent: { toolName: string; count: number } | null;
} {
  const history = state.toolCallHistory ?? [];
  const patterns = new Map<string, { toolName: string; count: number }>();

  for (const call of history) {
    const key = call.argsHash;
    const existing = patterns.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      patterns.set(key, { toolName: call.toolName, count: 1 });
    }
  }

  let mostFrequent: { toolName: string; count: number } | null = null;
  for (const pattern of patterns.values()) {
    if (!mostFrequent || pattern.count > mostFrequent.count) {
      mostFrequent = pattern;
    }
  }

  return {
    totalCalls: history.length,
    uniquePatterns: patterns.size,
    mostFrequent,
  };
}
