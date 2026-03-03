import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveMemoryBackendConfig } from "./backend-config.js";
const log = createSubsystemLogger("memory");
const QMD_MANAGER_CACHE = new Map();
export async function getMemorySearchManager(params) {
    const resolved = resolveMemoryBackendConfig(params);
    if (resolved.backend === "qmd" && resolved.qmd) {
        const statusOnly = params.purpose === "status";
        const cacheKey = buildQmdCacheKey(params.agentId, resolved.qmd);
        if (!statusOnly) {
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
                const wrapper = new FallbackMemoryManager({
                    primary,
                    fallbackFactory: async () => {
                        const { MemoryIndexManager } = await import("./manager.js");
                        return await MemoryIndexManager.get(params);
                    },
                }, () => QMD_MANAGER_CACHE.delete(cacheKey));
                QMD_MANAGER_CACHE.set(cacheKey, wrapper);
                return { manager: wrapper };
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.warn(`qmd memory unavailable; falling back to builtin: ${message}`);
        }
    }
    try {
        const { MemoryIndexManager } = await import("./manager.js");
        const manager = await MemoryIndexManager.get(params);
        return { manager };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { manager: null, error: message };
    }
}
class FallbackMemoryManager {
    deps;
    onClose;
    fallback = null;
    primaryFailed = false;
    lastError;
    cacheEvicted = false;
    constructor(deps, onClose) {
        this.deps = deps;
        this.onClose = onClose;
    }
    async search(query, opts) {
        if (!this.primaryFailed) {
            try {
                return await this.deps.primary.search(query, opts);
            }
            catch (err) {
                this.primaryFailed = true;
                this.lastError = err instanceof Error ? err.message : String(err);
                log.warn(`qmd memory failed; switching to builtin index: ${this.lastError}`);
                await this.deps.primary.close?.().catch(() => { });
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
    async readFile(params) {
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
    async sync(params) {
        if (!this.primaryFailed) {
            await this.deps.primary.sync?.(params);
            return;
        }
        const fallback = await this.ensureFallback();
        await fallback?.sync?.(params);
    }
    async probeEmbeddingAvailability() {
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
    async ensureFallback() {
        if (this.fallback) {
            return this.fallback;
        }
        let fallback;
        try {
            fallback = await this.deps.fallbackFactory();
            if (!fallback) {
                log.warn("memory fallback requested but builtin index is unavailable");
                return null;
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.warn(`memory fallback unavailable: ${message}`);
            return null;
        }
        this.fallback = fallback;
        return this.fallback;
    }
    evictCacheEntry() {
        if (this.cacheEvicted) {
            return;
        }
        this.cacheEvicted = true;
        this.onClose?.();
    }
}
function buildQmdCacheKey(agentId, config) {
    return `${agentId}:${stableSerialize(config)}`;
}
function stableSerialize(value) {
    return JSON.stringify(sortValue(value));
}
function sortValue(value) {
    if (Array.isArray(value)) {
        return value.map((entry) => sortValue(entry));
    }
    if (value && typeof value === "object") {
        const sortedEntries = Object.keys(value)
            .toSorted((a, b) => a.localeCompare(b))
            .map((key) => [key, sortValue(value[key])]);
        return Object.fromEntries(sortedEntries);
    }
    return value;
}
