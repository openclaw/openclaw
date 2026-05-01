import type { OpenClawConfig } from "./types.js";

export const DEFAULT_AGENT_MAX_CONCURRENT = 4;
// Lowered from 8 to 3: each subagent startup performs heavy synchronous
// work on the main event loop (plugin loading, model warmup, system prompt
// assembly) before the lane enqueue. With 8 concurrent, parallel spawns
// saturate the event loop for 5-6+ seconds, triggering liveness 1012
// restarts. 3 concurrent keeps fan-out viable while bounding the prep-phase
// event-loop pressure. Users who need wider concurrency can override via
// agents.defaults.subagents.maxConcurrent in config. See #75378.
export const DEFAULT_SUBAGENT_MAX_CONCURRENT = 3;
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
