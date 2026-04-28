import { listAgentEntries, listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveMemoryBackendConfig,
  type ResolvedQmdConfig,
} from "../memory-host-sdk/host/backend-config.js";
import { getActiveMemorySearchManager } from "../plugins/memory-runtime.js";
import { normalizeAgentId } from "../routing/session-key.js";

const DEFAULT_QMD_STARTUP_JITTER_MS = 100;

function shouldStartQmdBackgroundWork(qmd: ResolvedQmdConfig): boolean {
  return qmd.update.onBoot || qmd.update.intervalMs > 0 || qmd.update.embedIntervalMs > 0;
}

function hasExplicitAgentMemorySearchConfig(cfg: OpenClawConfig, agentId: string): boolean {
  return listAgentEntries(cfg).some(
    (entry) => normalizeAgentId(entry.id) === agentId && entry.memorySearch != null,
  );
}

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

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    timeout.unref?.();
  });
}

function resolveStartupJitterMs(params: { index: number; total: number }): number {
  if (params.index <= 0 || params.total <= 1) {
    return 0;
  }
  return Math.floor(Math.random() * DEFAULT_QMD_STARTUP_JITTER_MS);
}

export async function startGatewayMemoryBackend(params: {
  cfg: OpenClawConfig;
  log: { info?: (msg: string) => void; warn: (msg: string) => void };
}): Promise<void> {
  const agentIds = listAgentIds(params.cfg);
  const eagerAgentIds: string[] = [];
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
    if (!shouldStartQmdBackgroundWork(resolved.qmd)) {
      continue;
    }
    if (
      !shouldEagerlyStartAgentMemory({
        cfg: params.cfg,
        agentId,
        agentCount: agentIds.length,
      })
    ) {
      deferredAgentIds.push(agentId);
      continue;
    }

    eagerAgentIds.push(agentId);
  }
  const startupResults = await Promise.all(
    eagerAgentIds.map(async (agentId, index) => {
      await delay(resolveStartupJitterMs({ index, total: eagerAgentIds.length }));
      const { manager, error } = await getActiveMemorySearchManager({ cfg: params.cfg, agentId });
      return { agentId, manager, error };
    }),
  );
  const armedAgentIds: string[] = [];
  for (const { agentId, manager, error } of startupResults) {
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
      `qmd memory startup initialization armed for ${formatAgentCount(armedAgentIds.length)}: ${armedAgentIds
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
