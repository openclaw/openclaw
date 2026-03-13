import type { SessionEntry } from "./types.js";

type SessionStoreCacheEntry = {
  store: Record<string, SessionEntry>;
  loadedAt: number;
  storePath: string;
  mtimeMs?: number;
  sizeBytes?: number;
  serialized?: string;
};

const SESSION_STORE_CACHE = new Map<string, SessionStoreCacheEntry>();
const SESSION_STORE_SERIALIZED_CACHE = new Map<string, string>();

export function clearSessionStoreCaches(): void {
  SESSION_STORE_CACHE.clear();
  SESSION_STORE_SERIALIZED_CACHE.clear();
}

export function invalidateSessionStoreCache(storePath: string): void {
  SESSION_STORE_CACHE.delete(storePath);
  SESSION_STORE_SERIALIZED_CACHE.delete(storePath);
}

export function getSerializedSessionStore(storePath: string): string | undefined {
  return SESSION_STORE_SERIALIZED_CACHE.get(storePath);
}

export function setSerializedSessionStore(storePath: string, serialized?: string): void {
  if (serialized === undefined) {
    SESSION_STORE_SERIALIZED_CACHE.delete(storePath);
    return;
  }
  SESSION_STORE_SERIALIZED_CACHE.set(storePath, serialized);
}

export function dropSessionStoreObjectCache(storePath: string): void {
  SESSION_STORE_CACHE.delete(storePath);
}

export function readSessionStoreCache(params: {
  storePath: string;
  ttlMs: number;
  mtimeMs?: number;
  sizeBytes?: number;
}): Record<string, SessionEntry> | null {
  const cached = SESSION_STORE_CACHE.get(params.storePath);
  if (!cached) {
    return null;
  }
  const now = Date.now();
  if (now - cached.loadedAt > params.ttlMs) {
    invalidateSessionStoreCache(params.storePath);
    return null;
  }
  if (params.mtimeMs !== cached.mtimeMs || params.sizeBytes !== cached.sizeBytes) {
    invalidateSessionStoreCache(params.storePath);
    return null;
  }
  // Use JSON.parse instead of structuredClone to avoid native (C++) memory accumulation.
  // structuredClone allocates serialization buffers outside the V8 heap that GC cannot
  // reclaim fast enough for large/frequent session stores. Session stores contain only
  // JSON-serializable data (no Dates, Maps, or circular refs), so this is safe.
  return cached.serialized
    ? JSON.parse(cached.serialized)
    : JSON.parse(JSON.stringify(cached.store));
}

export function writeSessionStoreCache(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  mtimeMs?: number;
  sizeBytes?: number;
  serialized?: string;
}): void {
  SESSION_STORE_CACHE.set(params.storePath, {
    // JSON-based deep copy to avoid native memory leaks from structuredClone (see readSessionStoreCache).
    store: params.serialized
      ? JSON.parse(params.serialized)
      : JSON.parse(JSON.stringify(params.store)),
    loadedAt: Date.now(),
    storePath: params.storePath,
    mtimeMs: params.mtimeMs,
    sizeBytes: params.sizeBytes,
    serialized: params.serialized,
  });
  if (params.serialized !== undefined) {
    SESSION_STORE_SERIALIZED_CACHE.set(params.storePath, params.serialized);
  }
}
