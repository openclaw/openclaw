import { listAgentIds } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getActiveMemorySearchManager,
  resolveActiveMemoryBackendConfig,
} from "../plugins/memory-runtime.js";
import { listExistingAgentIdsFromDisk } from "./agent-list.js";

/**
 * Upper bound on how many agents get a startup prewarm. Per-user agents can
 * accumulate on disk; warming each one creates a cached index manager, so a
 * runaway agents dir should not turn startup into an unbounded background job.
 */
const MAX_PREWARM_AGENTS = 100;

/**
 * Soft per-agent budget for the builtin prewarm. A stuck embedding model load
 * or index sync should not starve the remaining agents in the serial queue.
 * The timed-out work keeps running in the background (the manager caches its
 * provider init promise), so a later real search still benefits from it.
 *
 * Set to 60s because per-user agents (e.g. rabbitmq-<uid>) with large memory
 * stores need longer than 30s to finish their initial index sync; warming them
 * fully here avoids paying that cost on the user's first message.
 */
const PREWARM_AGENT_TIMEOUT_MS = 60_000;

type GatewayStartupLog = { info?: (msg: string) => void; warn: (msg: string) => void };

function withSoftTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Union of configured agents and agents that already exist on disk (e.g.
 * dynamically created per-user agents such as `rabbitmq-<uid>`), preserving
 * configured order first. Dynamic agents never appear in `cfg.agents.list`,
 * but returning users hit them on every gateway restart — exactly the cold
 * start the prewarm exists to absorb.
 */
function listPrewarmAgentIds(cfg: OpenClawConfig): { agentIds: string[]; truncated: number } {
  const seen = new Set<string>();
  const agentIds: string[] = [];
  for (const agentId of [...listAgentIds(cfg), ...listExistingAgentIdsFromDisk()]) {
    if (!agentId || seen.has(agentId)) {
      continue;
    }
    seen.add(agentId);
    agentIds.push(agentId);
  }
  if (agentIds.length <= MAX_PREWARM_AGENTS) {
    return { agentIds, truncated: 0 };
  }
  return {
    agentIds: agentIds.slice(0, MAX_PREWARM_AGENTS),
    truncated: agentIds.length - MAX_PREWARM_AGENTS,
  };
}

/** Prewarm one agent's memory backend. Returns true when warm work was done. */
async function prewarmAgentMemory(params: {
  cfg: OpenClawConfig;
  agentId: string;
  log: GatewayStartupLog;
}): Promise<boolean> {
  const { cfg, agentId, log } = params;
  if (!resolveMemorySearchConfig(cfg, agentId)) {
    return false;
  }
  const resolved = resolveActiveMemoryBackendConfig({ cfg, agentId });
  if (!resolved) {
    return false;
  }

  if (resolved.backend === "qmd" && resolved.qmd) {
    const { manager, error } = await getActiveMemorySearchManager({ cfg, agentId });
    if (!manager) {
      log.warn(
        `qmd memory startup initialization failed for agent "${agentId}": ${error ?? "unknown error"}`,
      );
      return false;
    }
    log.info?.(`qmd memory startup initialization armed for agent "${agentId}"`);
    return true;
  }

  if (resolved.backend !== "builtin") {
    return false;
  }
  const startedAt = Date.now();
  const { manager, error } = await getActiveMemorySearchManager({ cfg, agentId });
  if (!manager) {
    log.warn(`memory startup prewarm failed for agent "${agentId}": ${error ?? "unknown error"}`);
    return false;
  }
  // Loads the embedding provider (local model / remote client) or settles
  // into FTS-only mode; either way the decision no longer blocks a turn.
  // Then build/refresh the index so the first search skips its force-sync
  // bootstrap path.
  const probe = await withSoftTimeout(
    (async () => {
      const probeResult = await manager.probeEmbeddingAvailability();
      await manager.sync?.({ reason: "gateway-startup-prewarm" });
      return probeResult;
    })(),
    PREWARM_AGENT_TIMEOUT_MS,
    `memory prewarm for agent "${agentId}"`,
  );
  const elapsedMs = Date.now() - startedAt;
  log.info?.(
    `memory startup prewarm done for agent "${agentId}" in ${elapsedMs}ms` +
      (probe.ok ? "" : ` (FTS-only: ${probe.error ?? "embeddings unavailable"})`),
  );
  return true;
}

/**
 * Initialize memory backends for all known agents at gateway startup so the
 * first `memory_search` of a session does not pay the cold start (sqlite
 * open + embedding provider load + initial index sync — observed at ~11s).
 *
 * - qmd backend: creating the manager arms qmd's own background indexing.
 * - builtin backend: probe embeddings (loads the provider/model) and run one
 *   sync so the index is built before the first user message arrives.
 *
 * Agents are warmed serially: provider init can load a local embedding model,
 * and loading several copies concurrently would spike CPU/RAM at startup.
 * Any single agent failing (config error, DB down, timeout) only logs a
 * warning; the remaining agents still get their prewarm.
 */
export async function startGatewayMemoryBackend(params: {
  cfg: OpenClawConfig;
  log: GatewayStartupLog;
}): Promise<void> {
  const startedAt = Date.now();
  const { agentIds, truncated } = listPrewarmAgentIds(params.cfg);
  if (truncated > 0) {
    params.log.warn(
      `memory startup prewarm capped at ${MAX_PREWARM_AGENTS} agents (${truncated} skipped)`,
    );
  }
  let warmed = 0;
  for (const agentId of agentIds) {
    try {
      if (await prewarmAgentMemory({ cfg: params.cfg, agentId, log: params.log })) {
        warmed += 1;
      }
    } catch (err) {
      params.log.warn(`memory startup prewarm failed for agent "${agentId}": ${String(err)}`);
    }
  }
  if (warmed > 0) {
    params.log.info?.(
      `memory startup prewarm finished: ${warmed}/${agentIds.length} agent(s) in ${Date.now() - startedAt}ms`,
    );
  }
}
