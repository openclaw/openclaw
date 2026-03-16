import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ResolvedQmdConfig } from "./backend-config.js";
import { checkQmdBinaryAvailable, resolveMemoryBackendConfig } from "./backend-config.js";
import type {
  MemoryEmbeddingProbeResult,
  MemorySearchManager,
  MemorySyncProgressUpdate,
} from "./types.js";

const log = createSubsystemLogger("memory");
const QMD_MANAGER_CACHE = new Map<string, MemorySearchManager>();
const QMD_BINARY_CHECK_CACHE = new Map<string, { available: boolean; timestamp: number }>();
const QMD_BINARY_CHECK_TTL_MS = 30_000; // 30 seconds TTL for binary check cache
let managerRuntimePromise: Promise<typeof import("./manager.js")> | null = null;

function loadManagerRuntime() {
  managerRuntimePromise ??= import("./manager.js");
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
    const cacheKey = buildQmdCacheKey(params.agentId, resolved.qmd);

    // Check cache first (fast path) before probing binary
    if (!statusOnly) {
      const cached = QMD_MANAGER_CACHE.get(cacheKey);
      if (cached) {
        return { manager: cached };
      }
    }

    // Check if QMD binary is available before attempting to create manager
    // Use agent workspace as cwd to ensure relative paths (e.g., ./bin/qmd) resolve correctly
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
    const binaryCheckKey = `${resolved.qmd.command}:${workspaceDir}`;

    // Check cached binary check result first (with TTL)
    const cachedCheck = QMD_BINARY_CHECK_CACHE.get(binaryCheckKey);
    const now = Date.now();
    let qmdCheck: { available: boolean; error?: string };
    if (cachedCheck && now - cachedCheck.timestamp < QMD_BINARY_CHECK_TTL_MS) {
      qmdCheck = { available: cachedCheck.available };
    } else {
      qmdCheck = await checkQmdBinaryAvailable(resolved.qmd.command, 5000, workspaceDir);
      QMD_BINARY_CHECK_CACHE.set(binaryCheckKey, {
        available: qmdCheck.available,
        timestamp: now,
      });
    }

    if (!qmdCheck.available) {
      log.warn(`QMD binary not available: ${qmdCheck.error}`);
      log.warn("Falling back to builtin memory backend. To use QMD, install it and ensure it's on PATH.");
      // Skip QMD creation and fall through to builtin backend
    } else {
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
          const wrapper = new FallbackMemoryManager(
            {
              primary,
              fallbackFactory: async () => {
                const { MemoryIndexManager } = await loadManagerRuntime();
                return await MemoryIndexManager.get(params);
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
  }

  try {
    const { MemoryIndexManager } = await loadManagerRuntime();
    const manager = await MemoryIndexManager.get(params);
    return { manager };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { manager: null, error: message };
  }
}

export async function closeAllMemorySearchManagers(): Promise<void> {
  // Close all cached QMD managers
  const managers = Array.from(QMD_MANAGER_CACHE.values());
  QMD_MANAGER_CACHE.clear();
  for (const manager of managers) {
    try {
      await manager.close?.();
    } catch (err) {
      log.warn(`failed to close qmd memory manager: ${String(err)}`);
    }
  }

  // Close all builtin memory index managers if runtime was loaded
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
    sessionFiles?: string[];
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
