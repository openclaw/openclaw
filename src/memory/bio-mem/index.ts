import type { OpenClawConfig } from "../../config/config.js";
import { createEmbeddingProvider } from "../embeddings.js";
import { requireNodeSqlite } from "../sqlite.js";
import { resolveMemorySearchConfig } from "../../agents/memory-search.js";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import { BioMemManager } from "./manager.js";

const BIOMEM_CACHE = new Map<string, BioMemManager>();

export async function getBioMemManager(
  cfg: OpenClawConfig,
  agentId: string,
): Promise<BioMemManager | null> {
  const bioMemCfg = cfg.memory?.bioMem;
  if (bioMemCfg?.enabled === false) {
    return null;
  }

  const memCfg = resolveMemorySearchConfig(cfg, agentId);
  if (!memCfg) {
    return null;
  }

  const cacheKey = `${agentId}:${memCfg.store.path}`;
  const cached = BIOMEM_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(memCfg.store.path);

    // Try to create embedding provider; fall back to null (keyword-only search)
    let embeddingProvider = null;
    try {
      const result = await createEmbeddingProvider({
        config: cfg,
        agentDir: resolveAgentDir(cfg, agentId),
        provider: memCfg.provider,
        remote: memCfg.remote,
        model: memCfg.model,
        fallback: memCfg.fallback,
        local: memCfg.local,
      });
      embeddingProvider = result.provider;
    } catch {
      // Embedding unavailable — BioMemManager falls back to keyword search
    }

    const manager = new BioMemManager(db, embeddingProvider);
    BIOMEM_CACHE.set(cacheKey, manager);
    return manager;
  } catch {
    return null;
  }
}
