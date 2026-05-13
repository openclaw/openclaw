import type { OpenClawConfig } from "./types.js";

export const DEFAULT_AGENT_MAX_CONCURRENT = 4;
export const DEFAULT_SUBAGENT_MAX_CONCURRENT = 8;
export const DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT = 5;
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

export function resolveSubagentQueueAwareTimeoutMs(params: {
  cfg?: OpenClawConfig;
  timeoutMs: number;
}): number {
  const timeoutMs = Math.max(0, Math.floor(params.timeoutMs));
  if (timeoutMs <= 0) {
    return timeoutMs;
  }
  const maxConcurrent = resolveSubagentMaxConcurrent(params.cfg);
  const rawMaxChildren = params.cfg?.agents?.defaults?.subagents?.maxChildrenPerAgent;
  const maxChildren =
    typeof rawMaxChildren === "number" && Number.isFinite(rawMaxChildren)
      ? Math.max(1, Math.floor(rawMaxChildren))
      : DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT;
  const batches = Math.max(1, Math.ceil(maxChildren / maxConcurrent));
  return timeoutMs * batches;
}
