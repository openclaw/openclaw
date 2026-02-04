/**
 * Progressive Memory Manager — singleton access to the ProgressiveMemoryStore.
 *
 * Provides a cached store instance and optional embed function for the new
 * progressive memory tools. This is the glue between MCP tools and the store.
 */

import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "./embeddings.js";
import { ProgressiveMemoryStore, type EmbedFn } from "./progressive-store.js";

const log = createSubsystemLogger("progressive-memory");

export type ProgressiveStoreAccess = {
  store: ProgressiveMemoryStore;
  embedFn?: EmbedFn;
};

/** Cache keyed by dbPath to avoid re-creating stores. */
const storeCache = new Map<string, ProgressiveStoreAccess>();

/**
 * Get or create a ProgressiveMemoryStore instance for the given config.
 * Initializes vector search on first access.
 */
export async function getProgressiveStore(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): Promise<ProgressiveStoreAccess> {
  const stateDir = resolveStateDir();
  const dbPath = path.join(stateDir, "memory", "progressive.db");

  const cached = storeCache.get(dbPath);
  if (cached) return cached;

  const store = new ProgressiveMemoryStore({ dbPath });

  // Try to initialize vector search
  try {
    await store.initVector();
  } catch (err) {
    log.warn?.(`Vector init failed (FTS-only mode): ${err}`);
  }

  // Try to create an embed function from the existing memory search config
  let embedFn: EmbedFn | undefined;
  try {
    const agentId = params.agentId ?? "main";
    const memSearchConfig = resolveMemorySearchConfig(params.cfg, agentId);
    if (memSearchConfig) {
      const providerResult = await createEmbeddingProvider({
        config: params.cfg,
        provider: memSearchConfig.embedding.provider as "openai" | "local" | "gemini" | "auto",
        model: memSearchConfig.embedding.model,
        fallback: memSearchConfig.embedding.fallback as "openai" | "gemini" | "local" | "none",
        local: memSearchConfig.embedding.local,
      });
      if (providerResult?.provider) {
        const provider = providerResult.provider;
        embedFn = (text: string) => provider.embedQuery(text);
        log.info?.(`Embedding provider ready: ${provider.id} (${provider.model})`);
      }
    }
  } catch (err) {
    log.warn?.(`Embedding provider setup failed (dedup/vector disabled): ${err}`);
  }

  const access: ProgressiveStoreAccess = { store, embedFn };
  storeCache.set(dbPath, access);
  return access;
}

/**
 * Close and remove all cached stores. Called during shutdown.
 */
export function closeAllProgressiveStores(): void {
  for (const [key, access] of storeCache) {
    try {
      access.store.close();
    } catch {
      // ignore
    }
  }
  storeCache.clear();
}

/**
 * Check if progressive memory is enabled in config.
 */
export function isProgressiveMemoryEnabled(cfg: OpenClawConfig): boolean {
  return cfg.memory?.progressive?.enabled === true;
}
