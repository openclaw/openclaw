import type { OpenClawConfig } from "../config/config.js";
import type { ResolvedQmdConfig } from "./backend-config.js";
import type {
  MemoryEmbeddingProbeResult,
  MemorySearchManager,
  MemorySyncProgressUpdate,
} from "./types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveMemoryBackendConfig } from "./backend-config.js";

const log = createSubsystemLogger("memory");
const QMD_MANAGER_CACHE = new Map<string, MemorySearchManager>();

export type MemorySearchManagerResult = {
  manager: MemorySearchManager | null;
  error?: string;
};

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
              const { MemoryIndexManager } = await import("./manager.js");
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

  try {
    const { MemoryIndexManager } = await import("./manager.js");
    const manager = await MemoryIndexManager.get(params);
    return { manager };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { manager: null, error: message };
  }
}

class FallbackMemoryManager implements MemorySearchManager {
  private fallback: MemorySearchManager | null = null;
  private primaryDisabled = false;
  private consecutivePrimaryFailures = 0;
  private lastError?: string;
  private readonly maxConsecutiveFailuresBeforeDisable: number;

  constructor(
    private readonly deps: {
      primary: MemorySearchManager;
      fallbackFactory: () => Promise<MemorySearchManager | null>;
    },
    private readonly onClose?: () => void,
    opts?: { maxConsecutiveFailuresBeforeDisable?: number },
  ) {
    this.maxConsecutiveFailuresBeforeDisable = Math.max(
      1,
      opts?.maxConsecutiveFailuresBeforeDisable ?? 5,
    );
  }

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ) {
    if (!this.primaryDisabled) {
      try {
        const results = await this.deps.primary.search(query, opts);
        if (this.consecutivePrimaryFailures > 0) {
          log.info(
            `qmd memory recovered after ${this.consecutivePrimaryFailures} failure(s); resuming primary`,
          );
          this.consecutivePrimaryFailures = 0;
          this.lastError = undefined;
        }
        return results;
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        const transient = isTransientQmdError(err);

        if (transient) {
          // Per-query fallback only. Do not permanently disable QMD for transient failures.
          log.warn(
            `qmd memory search failed (transient; consecutive=${this.consecutivePrimaryFailures}); falling back to builtin for this query: ${this.lastError}`,
          );
        } else {
          this.consecutivePrimaryFailures += 1;
          const threshold = this.maxConsecutiveFailuresBeforeDisable;
          if (this.consecutivePrimaryFailures >= threshold) {
            this.primaryDisabled = true;
            log.warn(
              `qmd memory search failed ${this.consecutivePrimaryFailures}x; disabling qmd and switching to builtin index: ${this.lastError}`,
            );
            await this.deps.primary.close?.().catch(() => {});
          } else {
            log.warn(
              `qmd memory search failed (consecutive=${this.consecutivePrimaryFailures}/${threshold}); falling back to builtin for this query: ${this.lastError}`,
            );
          }
        }

        const fallback = await this.ensureFallback();
        if (fallback) {
          return await fallback.search(query, opts);
        }
      }
    }
    const fallback = await this.ensureFallback();
    if (fallback) {
      return await fallback.search(query, opts);
    }
    throw new Error(this.lastError ?? "memory search unavailable");
  }

  async readFile(params: { relPath: string; from?: number; lines?: number }) {
    if (!this.primaryDisabled) {
      return await this.deps.primary.readFile(params);
    }
    const fallback = await this.ensureFallback();
    if (fallback) {
      return await fallback.readFile(params);
    }
    throw new Error(this.lastError ?? "memory read unavailable");
  }

  status() {
    if (!this.primaryDisabled) {
      const status = this.deps.primary.status();
      const custom = status.custom ?? {};
      if (this.consecutivePrimaryFailures > 0) {
        return {
          ...status,
          custom: {
            ...custom,
            fallback: {
              ...(custom.fallback ?? {}),
              consecutiveFailures: this.consecutivePrimaryFailures,
              lastError: this.lastError ?? "unknown",
            },
          },
        };
      }
      return status;
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
    if (!this.primaryDisabled) {
      await this.deps.primary.sync?.(params);
      return;
    }
    const fallback = await this.ensureFallback();
    await fallback?.sync?.(params);
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    if (!this.primaryDisabled) {
      return await this.deps.primary.probeEmbeddingAvailability();
    }
    const fallback = await this.ensureFallback();
    if (fallback) {
      return await fallback.probeEmbeddingAvailability();
    }
    return { ok: false, error: this.lastError ?? "memory embeddings unavailable" };
  }

  async probeVectorAvailability() {
    if (!this.primaryDisabled) {
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

function isTransientQmdError(err: unknown): boolean {
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  if (typeof code === "string") {
    if (code === "ENOENT") {
      return false;
    }
    if (
      code === "ETIMEDOUT" ||
      code === "ECONNRESET" ||
      code === "EPIPE" ||
      code === "EAI_AGAIN" ||
      code === "ECONNREFUSED" ||
      code === "ENETUNREACH" ||
      code === "EHOSTUNREACH"
    ) {
      return true;
    }
  }

  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return true;
  }
  if (lower.includes("database is locked") || lower.includes("resource busy")) {
    return true;
  }
  if (lower.includes("temporarily unavailable") || lower.includes("try again")) {
    return true;
  }
  return false;
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
