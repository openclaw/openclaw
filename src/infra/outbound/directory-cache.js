export function buildDirectoryCacheKey(key) {
    const signature = key.signature ?? "default";
    return `${key.channel}:${key.accountId ?? "default"}:${key.kind}:${key.source}:${signature}`;
}
export class DirectoryCache {
    ttlMs;
    cache = new Map();
    lastConfigRef = null;
    maxSize;
    constructor(ttlMs, maxSize = 2000) {
        this.ttlMs = ttlMs;
        this.maxSize = Math.max(1, Math.floor(maxSize));
    }
    get(key, cfg) {
        this.resetIfConfigChanged(cfg);
        this.pruneExpired(Date.now());
        const entry = this.cache.get(key);
        if (!entry) {
            return undefined;
        }
        return entry.value;
    }
    set(key, value, cfg) {
        this.resetIfConfigChanged(cfg);
        const now = Date.now();
        this.pruneExpired(now);
        // Refresh insertion order so active keys are less likely to be evicted.
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }
        this.cache.set(key, { value, fetchedAt: now });
        this.evictToMaxSize();
    }
    clearMatching(match) {
        for (const key of this.cache.keys()) {
            if (match(key)) {
                this.cache.delete(key);
            }
        }
    }
    clear(cfg) {
        this.cache.clear();
        if (cfg) {
            this.lastConfigRef = cfg;
        }
    }
    resetIfConfigChanged(cfg) {
        if (this.lastConfigRef && this.lastConfigRef !== cfg) {
            this.cache.clear();
        }
        this.lastConfigRef = cfg;
    }
    pruneExpired(now) {
        if (this.ttlMs <= 0) {
            return;
        }
        for (const [cacheKey, entry] of this.cache.entries()) {
            if (now - entry.fetchedAt > this.ttlMs) {
                this.cache.delete(cacheKey);
            }
        }
    }
    evictToMaxSize() {
        while (this.cache.size > this.maxSize) {
            const oldestKey = this.cache.keys().next().value;
            if (typeof oldestKey !== "string") {
                break;
            }
            this.cache.delete(oldestKey);
        }
    }
}
