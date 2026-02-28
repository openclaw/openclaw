/**
 * Per-agentic-run runtime metrics module
 *
 * Tracks baseline vs gated execution metrics including LLM calls, tool executions,
 * routing decisions, retries, subagent spawns, and decision outcomes.
 *
 * Metrics are deterministic and generated as end-of-run reports.
 */

import { randomUUID } from "node:crypto";

/**
 * Runtime metrics for a single agent run
 */
export type RunMetrics = {
  /** Unique identifier for this run */
  runId: string;
  /** Milliseconds since epoch when run started */
  startedAtMs: number;
  /** Milliseconds since epoch when run ended (undefined if still running) */
  endedAtMs?: number;
  /** Number of LLM calls made during this run */
  llmCalls: number;
  /** Number of router/gating calls made during this run */
  routerCalls: number;
  /** Number of tool executions during this run */
  toolExecutions: number;
  /** Number of retries attempted during this run */
  retries: number;
  /** Number of subagent spawns during this run */
  subagentSpawns: number;
  /** Number of ABSTAIN_CLARIFY outcomes */
  abstains: number;
  /** Number of ABSTAIN_CONFIRM outcomes */
  confirms: number;
  /** Number of MODIFY outcomes */
  modifies: number;
  /** Number of PROCEED outcomes */
  proceeds: number;
};

/**
 * Creates a new RunMetrics instance with default values
 *
 * @param runId Optional run ID; if not provided, generates a UUID
 * @returns Initialized RunMetrics with all counters at 0
 */
export function createRunMetrics(runId?: string): RunMetrics {
  return {
    runId: runId || randomUUID(),
    startedAtMs: Date.now(),
    llmCalls: 0,
    routerCalls: 0,
    toolExecutions: 0,
    retries: 0,
    subagentSpawns: 0,
    abstains: 0,
    confirms: 0,
    modifies: 0,
    proceeds: 0,
  };
}

/**
 * Marks a run as ended by setting endedAtMs
 *
 * @param m The RunMetrics to finalize
 */
export function endRunMetrics(m: RunMetrics): void {
  m.endedAtMs = Date.now();
}

/**
 * Converts RunMetrics to JSON string with stable key order
 *
 * @param m The RunMetrics to serialize
 * @returns JSON string with keys in deterministic order
 */
export function metricsToJson(m: RunMetrics): string {
  const ordered: Record<string, unknown> = {
    runId: m.runId,
    startedAtMs: m.startedAtMs,
    endedAtMs: m.endedAtMs,
    llmCalls: m.llmCalls,
    routerCalls: m.routerCalls,
    toolExecutions: m.toolExecutions,
    retries: m.retries,
    subagentSpawns: m.subagentSpawns,
    abstains: m.abstains,
    confirms: m.confirms,
    modifies: m.modifies,
    proceeds: m.proceeds,
  };
  return JSON.stringify(ordered);
}

/**
 * Converts RunMetrics to a single-line, CI-safe log format
 *
 * @param m The RunMetrics to serialize
 * @returns Single-line log string safe for CI output
 */
export function metricsToOneLine(m: RunMetrics): string {
  return `CLARITYBURST_RUN_METRICS ${metricsToJson(m)}`;
}

/**
 * Increments the LLM calls counter
 */
export function incLLM(m: RunMetrics): void {
  m.llmCalls++;
}

/**
 * Increments the router calls counter
 */
export function incRouter(m: RunMetrics): void {
  m.routerCalls++;
}

/**
 * Increments the tool executions counter
 */
export function incTool(m: RunMetrics): void {
  m.toolExecutions++;
}

/**
 * Increments the retries counter
 */
export function incRetry(m: RunMetrics): void {
  m.retries++;
}

/**
 * Increments the subagent spawns counter
 */
export function incSubagent(m: RunMetrics): void {
  m.subagentSpawns++;
}

/**
 * Increments the appropriate outcome counter
 *
 * @param m The RunMetrics to update
 * @param outcome One of: PROCEED, ABSTAIN_CLARIFY, ABSTAIN_CONFIRM, MODIFY
 */
export function incOutcome(
  m: RunMetrics,
  outcome: "PROCEED" | "ABSTAIN_CLARIFY" | "ABSTAIN_CONFIRM" | "MODIFY"
): void {
  switch (outcome) {
    case "PROCEED":
      m.proceeds++;
      break;
    case "ABSTAIN_CLARIFY":
      m.abstains++;
      break;
    case "ABSTAIN_CONFIRM":
      m.confirms++;
      break;
    case "MODIFY":
      m.modifies++;
      break;
  }
}
