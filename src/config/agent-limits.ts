import type { OpenClawConfig } from "./types.js";

export const DEFAULT_AGENT_MAX_CONCURRENT = 4;
export const DEFAULT_SUBAGENT_MAX_CONCURRENT = 8;
// Keep depth-1 subagents as leaves unless config explicitly opts into nesting.
export const DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 1;
export const DEFAULT_A2A_MAX_CONCURRENT_FLOWS = 3;
export const DEFAULT_A2A_QUEUE_TIMEOUT_MS = 30_000;

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
 * A2A flows used to rely on a resolver that disappeared during refactors while
 * gateway startup still imports it. Keep the resolver here so startup remains
 * stable even when no dedicated A2A config is present yet.
 */
export function resolveA2AConcurrencyConfig(_cfg?: OpenClawConfig): {
  maxConcurrentFlows: number;
  queueTimeoutMs: number;
} {
  return {
    maxConcurrentFlows: DEFAULT_A2A_MAX_CONCURRENT_FLOWS,
    queueTimeoutMs: DEFAULT_A2A_QUEUE_TIMEOUT_MS,
  };
}
