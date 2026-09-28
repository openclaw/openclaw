// Resolves per-agent runtime limits from config.
import os from "node:os";
import { resolveOptionalIntegerOption } from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "./types.js";

const MIN_AGENT_MAX_CONCURRENT = 8;
const AGENT_RUNS_PER_CPU = 4;
let defaultAgentMaxConcurrent: number | undefined;

function resolveDefaultAgentMaxConcurrent(): number {
  if (defaultAgentMaxConcurrent === undefined) {
    // Prefer the quota-aware count on modern Node; retain the CPU-list fallback
    // for runtimes where availableParallelism is absent.
    const availableParallelism =
      typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
    defaultAgentMaxConcurrent = Math.max(
      MIN_AGENT_MAX_CONCURRENT,
      availableParallelism * AGENT_RUNS_PER_CPU,
    );
  }
  return defaultAgentMaxConcurrent;
}

/** Default maximum concurrent child-agent runs per immediate spawning/controller session. */
export const DEFAULT_SUBAGENT_MAX_CONCURRENT = 8;
/** Default maximum direct children a single agent run may spawn. */
export const DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT = 5;
/** Default age before completed subagent state is archived. */
export const DEFAULT_SUBAGENT_ARCHIVE_AFTER_MINUTES = 60;
// Allow recursive delegation by default while bounding each spawn lineage.
export const DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 5;
export function isSubagentSpawnDepthAllowed(
  depth: number,
  maxSpawnDepth = DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH,
): boolean {
  return depth < maxSpawnDepth;
}

/** Resolves top-level agent concurrency, flooring finite values and clamping to at least one. */
export function resolveAgentMaxConcurrent(cfg?: OpenClawConfig): number {
  return (
    resolveOptionalIntegerOption(cfg?.agents?.defaults?.maxConcurrent, { min: 1 }) ??
    resolveDefaultAgentMaxConcurrent()
  );
}

/** Resolves per-session subagent concurrency, flooring finite values and clamping to at least one. */
export function resolveSubagentMaxConcurrent(cfg?: OpenClawConfig): number {
  return (
    resolveOptionalIntegerOption(cfg?.agents?.defaults?.subagents?.maxConcurrent, { min: 1 }) ??
    DEFAULT_SUBAGENT_MAX_CONCURRENT
  );
}
