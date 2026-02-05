import type { OpenClawConfig } from "../config/config.js";
import type { PluginSearchBackendRegistration } from "../plugins/types.js";
import type { ResolvedQmdConfig } from "./backend-config.js";
import type { ComposableBackendEntry } from "./composable-manager.js";
import type {
  MemoryEmbeddingProbeResult,
  MemorySearchManager,
  MemorySyncProgressUpdate,
} from "./types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveMemoryBackendConfig } from "./backend-config.js";
import { ComposableMemoryManager } from "./composable-manager.js";
import { memLog } from "./memory-log.js";

const log = createSubsystemLogger("memory");
const QMD_MANAGER_CACHE = new Map<string, MemorySearchManager>();

export type MemorySearchManagerResult = {
  manager: MemorySearchManager | null;
  error?: string;
};

export async function getMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
  pluginSearchBackends?: PluginSearchBackendRegistration[];
}): Promise<MemorySearchManagerResult> {
  const backends: ComposableBackendEntry[] = [];

  // 1. Builtin/QMD backend (existing logic)
  const resolved = resolveMemoryBackendConfig(params);
  memLog.trace("getMemorySearchManager: resolving", {
    agentId: params.agentId,
    backend: resolved.backend,
    hasQmd: Boolean(resolved.qmd),
  });

  if (resolved.backend === "qmd" && resolved.qmd) {
    const qmdManager = await resolveQmdBackend(params, resolved);
    if (qmdManager) {
      backends.push({ id: "qmd", manager: qmdManager, weight: 0.5 });
    }
  }

  // If no QMD, try builtin
  if (backends.length === 0) {
    try {
      const { MemoryIndexManager } = await import("./manager.js");
      const builtin = await MemoryIndexManager.get(params);
      if (builtin) {
        backends.push({ id: "builtin", manager: builtin, weight: 0.5 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      memLog.warn("getMemorySearchManager: builtin index failed", {
        agentId: params.agentId,
        error: message,
      });
    }
  }

  // 2. Progressive backend (if enabled)
  if (params.cfg.memory?.progressive?.enabled) {
    try {
      const progressiveManager = await resolveProgressiveBackend(params);
      if (progressiveManager) {
        backends.push({ id: "progressive", manager: progressiveManager, weight: 0.8 });
      }
    } catch (err) {
      memLog.warn("getMemorySearchManager: progressive backend failed", {
        error: String(err),
      });
    }
  }

  // 3. Graphiti backend (if configured)
  const graphitiCfg = params.cfg.memory?.graphiti;
  if (graphitiCfg?.enabled && graphitiCfg?.baseUrl) {
    try {
      const { GraphitiClient } = await import("./graphiti/client.js");
      const { GraphitiSearchAdapter } = await import("./graphiti/graphiti-search-adapter.js");
      const client = new GraphitiClient({
        baseUrl: graphitiCfg.baseUrl,
        apiKey: graphitiCfg.apiKey,
        timeoutMs: graphitiCfg.timeoutMs,
      });
      backends.push({ id: "graphiti", manager: new GraphitiSearchAdapter(client), weight: 0.7 });
    } catch (err) {
      memLog.warn("getMemorySearchManager: graphiti backend failed", {
        error: String(err),
      });
    }
  }

  // 4. Plugin-registered backends (Meridia, etc.)
  if (params.pluginSearchBackends) {
    for (const pb of params.pluginSearchBackends) {
      try {
        const manager = await pb.factory({ config: params.cfg, agentId: params.agentId });
        if (manager) {
          backends.push({ id: pb.id, manager, weight: pb.weight ?? 0.6 });
        }
      } catch (err) {
        memLog.warn(`getMemorySearchManager: plugin backend "${pb.id}" failed`, {
          error: String(err),
        });
      }
    }
  }

  memLog.trace("getMemorySearchManager: backends resolved", {
    agentId: params.agentId,
    backends: backends.map((b) => b.id),
  });

  if (backends.length === 0) {
    return { manager: null, error: "no memory backends available" };
  }

  // Single backend — skip composable overhead
  if (backends.length === 1) {
    return { manager: backends[0].manager };
  }

  // Multiple backends — compose
  const { parseQueryIntent } = await import("./query/index.js");
  return {
    manager: new ComposableMemoryManager({
      backends,
      intentParser: parseQueryIntent,
      primary: backends[0].id,
    }),
  };
}

async function resolveQmdBackend(
  params: { cfg: OpenClawConfig; agentId: string },
  resolved: ReturnType<typeof resolveMemoryBackendConfig>,
): Promise<MemorySearchManager | null> {
  if (!resolved.qmd) {
    return null;
  }
  const cacheKey = buildQmdCacheKey(params.agentId, resolved.qmd);
  const cached = QMD_MANAGER_CACHE.get(cacheKey);
  if (cached) {
    memLog.trace("getMemorySearchManager: qmd cache hit", { agentId: params.agentId });
    return cached;
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
            const { MemoryIndexManager } = await import("./manager.js");
            return await MemoryIndexManager.get(params);
          },
        },
        () => QMD_MANAGER_CACHE.delete(cacheKey),
      );
      QMD_MANAGER_CACHE.set(cacheKey, wrapper);
      return wrapper;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`qmd memory unavailable: ${message}`);
    memLog.warn("getMemorySearchManager: qmd failed", {
      agentId: params.agentId,
      error: message,
    });
  }
  return null;
}

async function resolveProgressiveBackend(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<MemorySearchManager | null> {
  try {
    const { ProgressiveSearchAdapter } = await import("./progressive-search-adapter.js");
    const { getProgressiveStore } = await import("./progressive-manager.js");
    const { store, embedFn } = await getProgressiveStore(params);
    return new ProgressiveSearchAdapter(store, embedFn);
  } catch (err) {
    memLog.warn("progressive backend init failed", { error: String(err) });
    return null;
  }
}

class FallbackMemoryManager implements MemorySearchManager {
  private fallback: MemorySearchManager | null = null;
  private primaryFailed = false;
  private lastError?: string;

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
        memLog.warn("FallbackMemoryManager: primary search failed, switching to builtin", {
          error: this.lastError,
          query: query.slice(0, 80),
        });
        await this.deps.primary.close?.().catch(() => {});
      }
    }
    memLog.trace("FallbackMemoryManager: using fallback for search", {
      query: query.slice(0, 80),
    });
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
    this.onClose?.();
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
