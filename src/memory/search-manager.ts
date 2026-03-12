import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  readMemoryDocumentFromPostgres,
  reconcileWorkspaceMemoryDocumentsToPostgres,
} from "../persistence/service.js";
import type { ResolvedQmdConfig } from "./backend-config.js";
import { resolveMemoryBackendConfig } from "./backend-config.js";
import type {
  MemoryEmbeddingProbeResult,
  MemorySearchManager,
  MemorySyncProgressUpdate,
} from "./types.js";

const log = createSubsystemLogger("memory");
const QMD_MANAGER_CACHE = new Map<string, MemorySearchManager>();
let managerRuntimePromise: Promise<typeof import("./manager-runtime.js")> | null = null;

function loadManagerRuntime() {
  managerRuntimePromise ??= import("./manager-runtime.js");
  return managerRuntimePromise;
}

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
          return {
            manager: wrapManagerWithPostgresMemoryReads({
              cfg: params.cfg,
              agentId: params.agentId,
              manager: primary,
            }),
          };
        }
        const wrapper = wrapManagerWithPostgresMemoryReads({
          cfg: params.cfg,
          agentId: params.agentId,
          manager: new FallbackMemoryManager(
            {
              primary,
              fallbackFactory: async () => {
                const { MemoryIndexManager } = await loadManagerRuntime();
                return await MemoryIndexManager.get(params);
              },
            },
            () => {
              if (cacheKey) {
                QMD_MANAGER_CACHE.delete(cacheKey);
              }
            },
          ),
        });
        if (cacheKey) {
          QMD_MANAGER_CACHE.set(cacheKey, wrapper!);
        }
        return {
          manager: wrapper,
          error: wrapper ? undefined : "memory search unavailable",
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`qmd memory unavailable; falling back to builtin: ${message}`);
    }
  }

  try {
    const { MemoryIndexManager } = await loadManagerRuntime();
    const manager = await MemoryIndexManager.get(params);
    return {
      manager: wrapManagerWithPostgresMemoryReads({
        cfg: params.cfg,
        agentId: params.agentId,
        manager,
        error: manager ? undefined : "memory search unavailable",
      }),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      manager: wrapManagerWithPostgresMemoryReads({
        cfg: params.cfg,
        agentId: params.agentId,
        manager: null,
        error: message,
      }),
      error: message,
    };
  }
}

export async function closeAllMemorySearchManagers(): Promise<void> {
  const managers = Array.from(QMD_MANAGER_CACHE.values());
  QMD_MANAGER_CACHE.clear();
  for (const manager of managers) {
    try {
      await manager.close?.();
    } catch (err) {
      log.warn(`failed to close qmd memory manager: ${String(err)}`);
    }
  }
  if (managerRuntimePromise !== null) {
    const { closeAllMemoryIndexManagers } = await loadManagerRuntime();
    await closeAllMemoryIndexManagers();
  }
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
    let fallback: MemorySearchManager | null;
    try {
      fallback = await this.deps.fallbackFactory();
      if (!fallback) {
        log.warn("memory fallback requested but builtin index is unavailable");
        return null;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`memory fallback unavailable: ${message}`);
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

function isSupportedMemoryReadPath(relPath: string): boolean {
  return relPath === "MEMORY.md" || relPath === "memory.md" || relPath.startsWith("memory/");
}

function sliceMemoryDocumentText(text: string, params: { from?: number; lines?: number }): string {
  if (params.from === undefined && params.lines === undefined) {
    return text;
  }
  const lines = text.split("\n");
  const start = Math.max(1, params.from ?? 1);
  const count = Math.max(1, params.lines ?? lines.length);
  return lines.slice(start - 1, start - 1 + count).join("\n");
}

function wrapManagerWithPostgresMemoryReads(params: {
  cfg: OpenClawConfig;
  agentId: string;
  manager: MemorySearchManager | null;
  error?: string;
}): MemorySearchManager | null {
  if (params.cfg.persistence?.backend !== "postgres") {
    return params.manager;
  }
  const workspaceRoot = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  if (!workspaceRoot) {
    return params.manager;
  }
  return new PostgresReadThroughMemoryManager({
    manager: params.manager,
    cfg: params.cfg,
    agentId: params.agentId,
    workspaceRoot,
    error: params.error,
  });
}

class PostgresReadThroughMemoryManager implements MemorySearchManager {
  constructor(
    private readonly deps: {
      manager: MemorySearchManager | null;
      cfg: OpenClawConfig;
      agentId: string;
      workspaceRoot: string;
      error?: string;
    },
  ) {}

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ) {
    if (!this.deps.manager) {
      throw new Error(this.deps.error ?? "memory search unavailable");
    }
    return await this.deps.manager.search(query, opts);
  }

  async readFile(params: { relPath: string; from?: number; lines?: number }) {
    const relPath = params.relPath?.trim();
    if (relPath && isSupportedMemoryReadPath(relPath)) {
      const postgresText = await readMemoryDocumentFromPostgres({
        config: this.deps.cfg,
        lookupMode: "runtime",
        workspaceRoot: this.deps.workspaceRoot,
        logicalPath: relPath,
      });
      if (postgresText === null) {
        throw new Error(`Memory document is unavailable in Postgres for ${relPath}.`);
      }
      return {
        text: sliceMemoryDocumentText(postgresText, params),
        path: relPath,
      };
    }
    if (!this.deps.manager) {
      throw new Error(this.deps.error ?? "memory read unavailable");
    }
    return await this.deps.manager.readFile(params);
  }

  status() {
    return (
      this.deps.manager?.status() ?? {
        backend: "builtin",
        provider: "postgres",
        fallback: {
          from: "postgres",
          reason: this.deps.error ?? "memory index unavailable",
        },
        custom: {
          searchAvailable: false,
        },
      }
    );
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }) {
    await this.deps.manager?.sync?.(params);
    if (
      this.deps.cfg.persistence?.backend !== "postgres" ||
      this.deps.cfg.persistence.postgres?.exportCompatibility === false
    ) {
      return;
    }
    await reconcileWorkspaceMemoryDocumentsToPostgres(
      {
        workspaceRoot: this.deps.workspaceRoot,
        agentId: this.deps.agentId,
      },
      {
        config: this.deps.cfg,
        lookupMode: "runtime",
      },
    );
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    if (!this.deps.manager) {
      return {
        ok: false,
        error: this.deps.error ?? "memory search unavailable",
      };
    }
    return await this.deps.manager.probeEmbeddingAvailability();
  }

  async probeVectorAvailability() {
    if (!this.deps.manager) {
      return false;
    }
    return await this.deps.manager.probeVectorAvailability();
  }

  async close() {
    await this.deps.manager?.close?.();
  }
}

function buildQmdCacheKey(agentId: string, config: ResolvedQmdConfig): string {
  // ResolvedQmdConfig is assembled in a stable field order in resolveMemoryBackendConfig.
  // Fast stringify avoids deep key-sorting overhead on this hot path.
  return `${agentId}:${JSON.stringify(config)}`;
}
