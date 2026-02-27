import { listAgentIds } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMemoryBackendConfig } from "../memory/backend-config.js";
import { getMemorySearchManager } from "../memory/index.js";
import { OpenMemorySyncManager } from "../memory/openmemory-sync-manager.js";

let openMemorySyncManager: OpenMemorySyncManager | null = null;

export async function startGatewayMemoryBackend(params: {
  cfg: OpenClawConfig;
  log: { info?: (msg: string) => void; warn: (msg: string) => void };
}): Promise<void> {
  const agentIds = listAgentIds(params.cfg);

  for (const agentId of agentIds) {
    if (!resolveMemorySearchConfig(params.cfg, agentId)) {
      continue;
    }
    const resolved = resolveMemoryBackendConfig({ cfg: params.cfg, agentId });

    // Handle QMD backend
    if (resolved.backend === "qmd" && resolved.qmd) {
      const { manager, error } = await getMemorySearchManager({ cfg: params.cfg, agentId });
      if (!manager) {
        params.log.warn(
          `qmd memory startup initialization failed for agent "${agentId}": ${error ?? "unknown error"}`,
        );
        continue;
      }
      params.log.info?.(`qmd memory startup initialization armed for agent "${agentId}"`);
    }

    // Handle OpenMemory backend
    if (resolved.backend === "openmemory" && resolved.openmemory) {
      try {
        const manager = await OpenMemorySyncManager.create({
          url: resolved.openmemory.url,
          userId: resolved.openmemory.userId,
          timeout: resolved.openmemory.timeout,
          agentId,
          deltaBytes: 100_000, // Sync after 100KB of new content
          deltaMessages: 50, // Or after 50 new messages
          syncIntervalMs: 5 * 60 * 1000, // Full sync every 5 minutes
          retentionDays: 90, // Keep sessions for 90 days
        });

        if (manager) {
          manager.startListening();
          openMemorySyncManager = manager;
          params.log.info?.(`OpenMemory session sync started for agent "${agentId}"`);
        }
      } catch (err) {
        params.log.warn(
          `OpenMemory sync manager failed to start for agent "${agentId}": ${String(err)}`,
        );
      }
    }
  }
}

export async function stopGatewayMemoryBackend(): Promise<void> {
  if (openMemorySyncManager) {
    await openMemorySyncManager.close();
    openMemorySyncManager = null;
  }
}
