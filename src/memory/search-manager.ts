import type { OpenClawConfig } from "../config/config.js";
import type { ResolvedQmdConfig } from "./backend-config.js";
import type {
  MemoryEmbeddingProbeResult,
  MemorySearchManager,
  MemorySyncProgressUpdate,
} from "./types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveMemoryBackendConfig } from "./backend-config.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";

const log = createSubsystemLogger("memory");
const QMD_MANAGER_CACHE = new Map<string, MemorySearchManager>();

export type MemorySearchManagerResult = {
  manager: MemorySearchManager | null;
  error?: string;
};

/**
 * Attempt to create a builtin MemoryIndexManager, returning null with a
 * descriptive error instead of propagating confusing "No API key" messages.
 *
 * When `memory.backend = "qmd"` and the user has NOT explicitly configured
 * `agents.defaults.memorySearch.provider`, the builtin index defaults to
 * `provider = "auto"`.  The auto strategy iterates openai → gemini → voyage,
 * each failing with "No API key found …" — none of which is relevant to the
 * user's intended QMD setup.
 *
 * This wrapper catches those cascading auth errors and returns a single
 * actionable message instead.
 *
 * See: https://github.com/openclaw/openclaw/issues/8131
 */
async function tryBuiltinIndex(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<MemorySearchManagerResult> {
  const searchCfg = resolveMemorySearchConfig(params.cfg, params.agentId);
  if (!searchCfg) {
    return { manager: null, error: "Memory search is disabled in configuration." };
  }

  try {
    const { MemoryIndexManager } = await import("./manager.js");
    const manager = await MemoryIndexManager.get(params);
    return { manager };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // When the error is about missing API keys and the user hasn't explicitly
    // chosen a remote provider, replace the confusing cascade of per-provider
    // auth errors with one clear message.
    const isApiKeyError = message.includes("No API key found for provider");
    const isAutoProvider = searchCfg.provider === "auto";

    if (isApiKeyError && isAutoProvider) {
      return {
        manager: null,
        error:
          "Memory search requires an embedding provider but none is configured. " +
          "Set agents.defaults.memorySearch.provider to \"local\" (requires node-llama-cpp), " +
          "\"openai\", \"gemini\", or \"voyage\" with the corresponding API key. " +
          "If you use memory.backend = \"qmd\", also ensure the qmd command is available.",
      };
    }

    return { manager: null, error: message };
  }
}

export async function getMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<MemorySearchManagerResult> {
  const resolved = resolveMemoryBackendConfig(params);
  if (resolved.backend === "qmd" && resolved.qmd) {
    const cacheKey = buildQmdCacheKey(params.agentId, resolved.qmd);
    const cached = QMD_MANAGER_CACHE.get(cacheKey);
    if (cached) {
      return { manager: cached };
    }
    try {
      const { QmdMemoryManager } = await import("./qmd-manager.js");
      const primary = await QmdMemoryManager.create({
        cfg: params.cfg,
        agentId: params.agentId,
        resolved,
      });
      if (primary) {
        const wrapper = new FallbackMemoryManager(
          {
            primary,
            fallbackFactory: async () => {
              const result = await tryBuiltinIndex(params);
              return result.manager;
            },
          },
          () => QMD_MANAGER_CACHE.delete(cacheKey),
        );
        QMD_MANAGER_CACHE.set(cacheKey, wrapper);
        return { manager: wrapper };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`qmd memory unavailable; falling back to builtin: ${message}`);
    }
  }

  return await tryBuiltinIndex(params);
}

class FallbackMemoryManager implements MemorySearchManager {
  private fallback: MemorySearchManager | null = null;
  private primaryFailed = false;
  private lastError?: string;
  private cacheEvicted = false;

  constructor(
    private readonly deps: {
      primary: MemorySearchManager;
      fallbackFactory: () => Promise<MemorySearchManager | null>;
    },
    private readonly onClose?: () => void,
  ) {}

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ) {
    if (!this.primaryFailed) {
      try {
        return await this.deps.primary.search(query, opts);
      } catch (err) {
        this.primaryFailed = true;
        this.lastError = err instanceof Error ? err.message : String(err);
        log.warn(`qmd memory failed; switching to builtin index: ${this.lastError}`);
        await this.deps.primary.close?.().catch(() => {});
        // Evict the failed wrapper so the next request can retry QMD with a fresh manager.
        this.evictCacheEntry();
      }
    }
    const fallback = await this.ensureFallback();
    if (fallback) {
      return await fallback.search(query, opts);
    }
    throw new Error(this.lastError ?? "memory search unavailable");
  }

  async readFile(params: { relPath: string; from?: number; lines?: number }) {
    if (!this.primaryFailed) {
      return await this.deps.primary.readFile(params);
    }
    const fallback = await this.ensureFallback();
    if (fallback) {
      return await fallback.readFile(params);
    }
    throw new Error(this.lastError ?? "memory read unavailable");
  }

  status() {
    if (!this.primaryFailed) {
      return this.deps.primary.status();
    }
    const fallbackStatus = this.fallback?.status();
    const fallbackInfo = { from: "qmd", reason: this.lastError ?? "unknown" };
    if (fallbackStatus) {
      const custom = fallbackStatus.custom ?? {};
      return {
        ...fallbackStatus,
        fallback: fallbackInfo,
        custom: {
          ...custom,
          fallback: { disabled: true, reason: this.lastError ?? "unknown" },
        },
      };
    }
    const primaryStatus = this.deps.primary.status();
    const custom = primaryStatus.custom ?? {};
    return {
      ...primaryStatus,
      fallback: fallbackInfo,
      custom: {
        ...custom,
        fallback: { disabled: true, reason: this.lastError ?? "unknown" },
      },
    };
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }) {
    if (!this.primaryFailed) {
      await this.deps.primary.sync?.(params);
      return;
    }
    const fallback = await this.ensureFallback();
    await fallback?.sync?.(params);
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    if (!this.primaryFailed) {
      return await this.deps.primary.probeEmbeddingAvailability();
    }
    const fallback = await this.ensureFallback();
    if (fallback) {
      return await fallback.probeEmbeddingAvailability();
    }
    return { ok: false, error: this.lastError ?? "memory embeddings unavailable" };
  }

  async probeVectorAvailability() {
    if (!this.primaryFailed) {
      return await this.deps.primary.probeVectorAvailability();
    }
    const fallback = await this.ensureFallback();
    return (await fallback?.probeVectorAvailability()) ?? false;
  }

  async close() {
    await this.deps.primary.close?.();
    await this.fallback?.close?.();
    this.evictCacheEntry();
  }

  private async ensureFallback(): Promise<MemorySearchManager | null> {
    if (this.fallback) {
      return this.fallback;
    }
    const fallback = await this.deps.fallbackFactory();
    if (!fallback) {
      log.warn("memory fallback requested but builtin index is unavailable");
      return null;
    }
    this.fallback = fallback;
    return this.fallback;
  }

  private evictCacheEntry(): void {
    if (this.cacheEvicted) {
      return;
    }
    this.cacheEvicted = true;
    this.onClose?.();
  }
}

function buildQmdCacheKey(agentId: string, config: ResolvedQmdConfig): string {
  return `${agentId}:${stableSerialize(config)}`;
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortValue(entry));
  }
  if (value && typeof value === "object") {
    const sortedEntries = Object.keys(value as Record<string, unknown>)
      .toSorted((a, b) => a.localeCompare(b))
      .map((key) => [key, sortValue((value as Record<string, unknown>)[key])]);
    return Object.fromEntries(sortedEntries);
  }
  return value;
}
