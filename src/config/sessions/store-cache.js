import { createExpiringMapCache, isCacheEnabled, resolveCacheTtlMs } from "../cache-utils.js";
const DEFAULT_SESSION_STORE_TTL_MS = 45_000; // 45 seconds (between 30-60s)
const SESSION_STORE_CACHE = createExpiringMapCache({
    ttlMs: getSessionStoreTtl,
});
const SESSION_STORE_SERIALIZED_CACHE = new Map();
export function getSessionStoreTtl() {
    return resolveCacheTtlMs({
        envValue: process.env.OPENCLAW_SESSION_CACHE_TTL_MS,
        defaultTtlMs: DEFAULT_SESSION_STORE_TTL_MS,
    });
}
export function isSessionStoreCacheEnabled() {
    return isCacheEnabled(getSessionStoreTtl());
}
export function clearSessionStoreCaches() {
    SESSION_STORE_CACHE.clear();
    SESSION_STORE_SERIALIZED_CACHE.clear();
}
export function invalidateSessionStoreCache(storePath) {
    SESSION_STORE_CACHE.delete(storePath);
    SESSION_STORE_SERIALIZED_CACHE.delete(storePath);
}
export function getSerializedSessionStore(storePath) {
    return SESSION_STORE_SERIALIZED_CACHE.get(storePath);
}
export function setSerializedSessionStore(storePath, serialized) {
    if (serialized === undefined) {
        SESSION_STORE_SERIALIZED_CACHE.delete(storePath);
        return;
    }
    SESSION_STORE_SERIALIZED_CACHE.set(storePath, serialized);
}
export function dropSessionStoreObjectCache(storePath) {
    SESSION_STORE_CACHE.delete(storePath);
}
export function readSessionStoreCache(params) {
    const cached = SESSION_STORE_CACHE.get(params.storePath);
    if (!cached) {
        return null;
    }
    if (params.mtimeMs !== cached.mtimeMs || params.sizeBytes !== cached.sizeBytes) {
        invalidateSessionStoreCache(params.storePath);
        return null;
    }
    return structuredClone(cached.store);
}
export function writeSessionStoreCache(params) {
    SESSION_STORE_CACHE.set(params.storePath, {
        store: structuredClone(params.store),
        mtimeMs: params.mtimeMs,
        sizeBytes: params.sizeBytes,
        serialized: params.serialized,
    });
    if (params.serialized !== undefined) {
        SESSION_STORE_SERIALIZED_CACHE.set(params.storePath, params.serialized);
    }
}
