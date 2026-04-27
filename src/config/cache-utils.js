import fs from "node:fs";
import { parseStrictNonNegativeInteger } from "../infra/parse-finite-number.js";
export function resolveCacheTtlMs(params) {
    const { envValue, defaultTtlMs } = params;
    if (envValue) {
        const parsed = parseStrictNonNegativeInteger(envValue);
        if (parsed !== undefined) {
            return parsed;
        }
    }
    return defaultTtlMs;
}
export function isCacheEnabled(ttlMs) {
    return ttlMs > 0;
}
function resolveCacheNumeric(value) {
    return typeof value === "function" ? value() : value;
}
function resolvePruneIntervalMs(ttlMs, pruneIntervalMs) {
    if (typeof pruneIntervalMs === "function") {
        return Math.max(0, Math.floor(pruneIntervalMs(ttlMs)));
    }
    if (typeof pruneIntervalMs === "number") {
        return Math.max(0, Math.floor(pruneIntervalMs));
    }
    return ttlMs;
}
function isCacheEntryExpired(storedAt, now, ttlMs) {
    return now - storedAt > ttlMs;
}
export function createExpiringMapCache(options) {
    const cache = new Map();
    const now = options.clock ?? Date.now;
    let lastPruneAt = 0;
    function getTtlMs() {
        return Math.max(0, Math.floor(resolveCacheNumeric(options.ttlMs)));
    }
    function maybePruneExpiredEntries(nowMs, ttlMs) {
        if (!isCacheEnabled(ttlMs)) {
            return;
        }
        if (nowMs - lastPruneAt < resolvePruneIntervalMs(ttlMs, options.pruneIntervalMs)) {
            return;
        }
        for (const [key, entry] of cache.entries()) {
            if (isCacheEntryExpired(entry.storedAt, nowMs, ttlMs)) {
                cache.delete(key);
            }
        }
        lastPruneAt = nowMs;
    }
    return {
        get: (key) => {
            const ttlMs = getTtlMs();
            if (!isCacheEnabled(ttlMs)) {
                return undefined;
            }
            const nowMs = now();
            maybePruneExpiredEntries(nowMs, ttlMs);
            const entry = cache.get(key);
            if (!entry) {
                return undefined;
            }
            if (isCacheEntryExpired(entry.storedAt, nowMs, ttlMs)) {
                cache.delete(key);
                return undefined;
            }
            return entry.value;
        },
        set: (key, value) => {
            const ttlMs = getTtlMs();
            if (!isCacheEnabled(ttlMs)) {
                return;
            }
            const nowMs = now();
            maybePruneExpiredEntries(nowMs, ttlMs);
            cache.set(key, {
                storedAt: nowMs,
                value,
            });
        },
        delete: (key) => {
            cache.delete(key);
        },
        clear: () => {
            cache.clear();
            lastPruneAt = 0;
        },
        keys: () => [...cache.keys()],
        size: () => cache.size,
        pruneExpired: () => {
            const ttlMs = getTtlMs();
            if (!isCacheEnabled(ttlMs)) {
                return;
            }
            const nowMs = now();
            for (const [key, entry] of cache.entries()) {
                if (isCacheEntryExpired(entry.storedAt, nowMs, ttlMs)) {
                    cache.delete(key);
                }
            }
            lastPruneAt = nowMs;
        },
    };
}
export function getFileStatSnapshot(filePath) {
    try {
        const stats = fs.statSync(filePath);
        return {
            mtimeMs: stats.mtimeMs,
            sizeBytes: stats.size,
        };
    }
    catch {
        return undefined;
    }
}
