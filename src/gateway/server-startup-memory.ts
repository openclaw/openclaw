import { listAgentEntries, listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveMemoryBackendConfig,
  type ResolvedQmdConfig,
} from "../memory-host-sdk/host/backend-config.js";
import { getActiveMemorySearchManager } from "../plugins/memory-runtime.js";
import { normalizeAgentId } from "../routing/session-key.js";

function shouldRunQmdStartupBootSync(qmd: ResolvedQmdConfig): boolean {
  return qmd.update.onBoot && qmd.update.startup !== "off";
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

const QMD_STARTUP_INIT_LABEL = "qmd memory startup initialization";
const BUILTIN_LOCAL_PREWARM_LABEL = "builtin local memory startup prewarm";

export async function startGatewayMemoryBackend(params: {
  cfg: OpenClawConfig;
  log: { info?: (msg: string) => void; warn: (msg: string) => void };
}): Promise<void> {
  const agentIds = listAgentIds(params.cfg);
  const qmdBootSyncedAgentIds: string[] = [];
  const deferredQmdAgentIds: string[] = [];
  const deferredBuiltinLocalAgentIds: string[] = [];
  for (const agentId of agentIds) {
    const memorySearchConfig = resolveMemorySearchConfig(params.cfg, agentId);
    if (!memorySearchConfig) {
      continue;
    }
    const resolved = resolveMemoryBackendConfig({ cfg: params.cfg, agentId });
    if (!resolved) {
      continue;
    }

    const shouldBootSyncQmd =
      resolved.backend === "qmd" && resolved.qmd
        ? shouldRunQmdStartupBootSync(resolved.qmd)
        : false;
    const shouldPrewarmBuiltinLocal =
      resolved.backend === "builtin" && memorySearchConfig.provider === "local";
    if (!shouldBootSyncQmd && !shouldPrewarmBuiltinLocal) {
      continue;
    }
    if (
      !shouldEagerlyStartAgentMemory({
        cfg: params.cfg,
        agentId,
        agentCount: agentIds.length,
      })
    ) {
      if (shouldBootSyncQmd) {
        deferredQmdAgentIds.push(agentId);
      } else {
        deferredBuiltinLocalAgentIds.push(agentId);
      }
      continue;
    }

    if (shouldBootSyncQmd) {
      const { manager, error } = await getActiveMemorySearchManager({
        cfg: params.cfg,
        agentId,
        purpose: "cli",
      });
      if (!manager) {
        params.log.warn(
          `${QMD_STARTUP_INIT_LABEL} failed for agent "${agentId}": ${error ?? "unknown error"}`,
        );
        continue;
      }
      try {
        await manager.sync?.({ reason: "boot", force: true });
      } catch (err) {
        params.log.warn(
          `qmd memory startup boot sync failed for agent "${agentId}": ${String(err)}`,
        );
        continue;
      } finally {
        await manager.close?.().catch((err) => {
          params.log.warn(
            `qmd memory startup manager close failed for agent "${agentId}": ${String(err)}`,
          );
        });
      }
      qmdBootSyncedAgentIds.push(agentId);
      continue;
    }

    const { manager, error } = await getActiveMemorySearchManager({
      cfg: params.cfg,
      agentId,
    });
    if (!manager) {
      params.log.warn(
        `${BUILTIN_LOCAL_PREWARM_LABEL} failed for agent "${agentId}": ${error ?? "unknown error"}`,
      );
      continue;
    }

    try {
      const probe = await manager.probeEmbeddingAvailability();
      if (!probe.ok) {
        params.log.warn(
          `${BUILTIN_LOCAL_PREWARM_LABEL} failed for agent "${agentId}": ${probe.error ?? "unknown error"}`,
        );
        continue;
      }
      params.log.info?.(`${BUILTIN_LOCAL_PREWARM_LABEL} completed for agent "${agentId}"`);
    } catch (err) {
      params.log.warn(
        `${BUILTIN_LOCAL_PREWARM_LABEL} failed for agent "${agentId}": ${String(err)}`,
      );
    }
  }
  if (qmdBootSyncedAgentIds.length > 0) {
    params.log.info?.(
      `qmd memory startup boot sync completed for ${formatAgentCount(qmdBootSyncedAgentIds.length)}: ${qmdBootSyncedAgentIds
        .map((agentId) => `"${agentId}"`)
        .join(", ")}`,
    );
  }
  if (deferredQmdAgentIds.length > 0) {
    params.log.info?.(
      `qmd memory startup initialization deferred for ${formatAgentCount(deferredQmdAgentIds.length)}: ${deferredQmdAgentIds
        .map((agentId) => `"${agentId}"`)
        .join(", ")}`,
    );
  }
  if (deferredBuiltinLocalAgentIds.length > 0) {
    params.log.info?.(
      `builtin local memory startup prewarm deferred for ${formatAgentCount(deferredBuiltinLocalAgentIds.length)}: ${deferredBuiltinLocalAgentIds
        .map((agentId) => `"${agentId}"`)
        .join(", ")}`,
    );
  }
}

function formatAgentCount(count: number): string {
  return count === 1 ? "1 agent" : `${count} agents`;
}
