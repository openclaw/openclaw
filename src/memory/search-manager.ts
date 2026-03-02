import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ResolvedQmdConfig } from "./backend-config.js";
import { resolveMemoryBackendConfig } from "./backend-config.js";
import type { MemorySearchManager } from "./types.js";

const log = createSubsystemLogger("memory");
const QMD_MANAGER_CACHE = new Map<string, MemorySearchManager>();

export type MemorySearchManagerResult = {
  manager: MemorySearchManager | null;
  error?: string;
};

export async function getMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status";
}): Promise<MemorySearchManagerResult> {
  const resolved = resolveMemoryBackendConfig(params);
  if (resolved.backend === "qmd" && resolved.qmd) {
    const statusOnly = params.purpose === "status";
    let cacheKey: string | undefined;
    if (!statusOnly) {
      cacheKey = buildQmdCacheKey(params.agentId, resolved.qmd);
      const cached = QMD_MANAGER_CACHE.get(cacheKey);
      if (cached) {
        return { manager: cached };
      }
    }
    try {
      const { QmdMemoryManager } = await import("./qmd-manager.js");
      const primary = await QmdMemoryManager.create({
        cfg: params.cfg,
        agentId: params.agentId,
        resolved,
        mode: statusOnly ? "status" : "full",
      });
      if (primary) {
        if (statusOnly) {
          return { manager: primary };
        }
        // When QMD is explicitly configured, we use QMD directly without fallback.
        // Users choose QMD specifically to avoid cloud embedding dependencies.
        // Falling back to builtin (which requires cloud providers) breaks that expectation.
        // See: https://github.com/openclaw/openclaw/issues/12021
        if (cacheKey) {
          QMD_MANAGER_CACHE.set(cacheKey, primary);
        }
        return { manager: primary };
      }
      // QMD was explicitly configured but returned null - don't fall back to builtin
      log.error(`QMD memory backend returned null (not falling back to builtin as QMD is explicitly configured)`);
      return { manager: null, error: `QMD backend returned null` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // When QMD is explicitly configured, don't silently fall back to builtin.
      // Return the actual QMD error so users know their chosen backend failed.
      log.error(`QMD memory backend failed (not falling back to builtin as QMD is explicitly configured): ${message}`);
      return { manager: null, error: `QMD backend error: ${message}` };
    }
  }

  try {
    const { MemoryIndexManager } = await import("./manager.js");
    const manager = await MemoryIndexManager.get(params);
    return { manager };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { manager: null, error: message };
  }
}

function buildQmdCacheKey(agentId: string, config: ResolvedQmdConfig): string {
  // ResolvedQmdConfig is assembled in a stable field order in resolveMemoryBackendConfig.
  // Fast stringify avoids deep key-sorting overhead on this hot path.
  return `${agentId}:${JSON.stringify(config)}`;
}
