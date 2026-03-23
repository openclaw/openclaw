import type { OpenClawConfig } from "./types.js";

export const DEFAULT_AGENT_MAX_CONCURRENT = 4;
export const DEFAULT_SUBAGENT_MAX_CONCURRENT = 8;
// Keep depth-1 subagents as leaves unless config explicitly opts into nesting.
export const DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 1;

export function resolveAgentMaxConcurrent(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.maxConcurrent;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  return DEFAULT_AGENT_MAX_CONCURRENT;
}

export function resolveSubagentMaxConcurrent(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.subagents?.maxConcurrent;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  return DEFAULT_SUBAGENT_MAX_CONCURRENT;
}

/**
 * Resolve a per-agent custom queue lane.  Returns `undefined` when the agent
 * should use the default "main" lane.
 */
export function resolveAgentLane(cfg?: OpenClawConfig, agentId?: string): string | undefined {
  if (!agentId || !cfg?.agents?.list) {
    return undefined;
  }
  const entry = cfg.agents.list.find((a) => a.id === agentId);
  const lane = (entry as Record<string, unknown> | undefined)?.lane;
  return typeof lane === "string" && lane.trim() ? lane.trim() : undefined;
}

/**
 * Resolve per-agent lane concurrency cap.  Returns `undefined` when the
 * agent has no custom lane or no explicit concurrency configured.
 */
export function resolveAgentLaneConcurrency(
  cfg?: OpenClawConfig,
  agentId?: string,
): number | undefined {
  if (!agentId || !cfg?.agents?.list) {
    return undefined;
  }
  const entry = cfg.agents.list.find((a) => a.id === agentId);
  const raw = (entry as Record<string, unknown> | undefined)?.laneConcurrency;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  return undefined;
}
