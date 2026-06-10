// Gateway memory startup helper.
// Starts qmd memory boot sync for eligible agents without loading every agent.
import { listAgentEntries, listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveMemoryBackendConfig,
  type ResolvedQmdConfig,
} from "../memory-host-sdk/host/backend-config.js";
import { getActiveMemorySearchManager } from "../plugins/memory-runtime.js";
import { normalizeAgentId } from "../routing/session-key.js";

/**
 * True when qmd memory config has startup work that requires a live manager.
 * `onBoot: false` suppresses the boot refresh only; interval and embed
 * maintenance still need startup to keep timers and file watches armed.
 */
export function hasQmdStartupWork(qmd: ResolvedQmdConfig): boolean {
  return (
    qmd.update.startup !== "off" &&
    (qmd.update.onBoot ||
      qmd.update.intervalMs > 0 ||
      (qmd.searchMode !== "search" && qmd.update.embedIntervalMs > 0))
  );
}

/** Check whether an agent overrides memory search instead of inheriting defaults. */
function hasExplicitAgentMemorySearchConfig(cfg: OpenClawConfig, agentId: string): boolean {
  return listAgentEntries(cfg).some(
    (entry) => normalizeAgentId(entry.id) === agentId && entry.memorySearch != null,
  );
}

/** Decide whether an agent's qmd memory manager should start during Gateway boot. */
function shouldEagerlyStartAgentMemory(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentCount: number;
}): boolean {
  if (params.agentCount <= 1) {
    return true;
  }
  if (params.agentId === resolveDefaultAgentId(params.cfg)) {
    return true;
  }
  if (params.cfg.agents?.defaults?.memorySearch?.enabled === true) {
    return true;
  }
  return hasExplicitAgentMemorySearchConfig(params.cfg, params.agentId);
}

/** Start qmd memory maintenance for eligible agents without eagerly loading every agent. */
export async function startGatewayMemoryBackend(params: {
  cfg: OpenClawConfig;
  log: { info?: (msg: string) => void; warn: (msg: string) => void };
}): Promise<void> {
  const agentIds = listAgentIds(params.cfg);
  const armedAgentIds: string[] = [];
  const deferredAgentIds: string[] = [];
  for (const agentId of agentIds) {
    if (!resolveMemorySearchConfig(params.cfg, agentId)) {
      continue;
    }
    const resolved = resolveMemoryBackendConfig({ cfg: params.cfg, agentId });
    if (!resolved) {
      continue;
    }
    if (resolved.backend !== "qmd" || !resolved.qmd) {
      continue;
    }
    if (!hasQmdStartupWork(resolved.qmd)) {
      continue;
    }
    if (
      !shouldEagerlyStartAgentMemory({
        cfg: params.cfg,
        agentId,
        agentCount: agentIds.length,
      })
    ) {
      // Multi-agent configs keep unconfigured non-default agents lazy so
      // Gateway startup does not initialize every possible qmd store.
      deferredAgentIds.push(agentId);
      continue;
    }

    const { manager, error } = await getActiveMemorySearchManager({
      cfg: params.cfg,
      agentId,
    });
    if (!manager) {
      params.log.warn(
        `qmd memory startup initialization failed for agent "${agentId}": ${error ?? "unknown error"}`,
      );
      continue;
    }
    armedAgentIds.push(agentId);
  }
  if (armedAgentIds.length > 0) {
    params.log.info?.(
      `qmd memory startup initialized for ${formatAgentCount(armedAgentIds.length)}: ${armedAgentIds
        .map((agentId) => `"${agentId}"`)
        .join(", ")}`,
    );
  }
  if (deferredAgentIds.length > 0) {
    params.log.info?.(
      `qmd memory startup initialization deferred for ${formatAgentCount(deferredAgentIds.length)}: ${deferredAgentIds
        .map((agentId) => `"${agentId}"`)
        .join(", ")}`,
    );
  }
}

function formatAgentCount(count: number): string {
  return count === 1 ? "1 agent" : `${count} agents`;
}
