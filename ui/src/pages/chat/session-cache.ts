import { pruneMapToMaxSize } from "../../../../src/infra/map-size.ts";

export const MAX_CACHED_CHAT_SESSIONS = 20;

export function getSessionCacheValue<T>(map: Map<string, T>, sessionKey: string): T | undefined {
  if (!map.has(sessionKey)) {
    return undefined;
  }
  const existing = map.get(sessionKey) as T;
  // Refresh insertion order so recently used sessions stay cached.
  map.delete(sessionKey);
  map.set(sessionKey, existing);
  return existing;
}

export function setSessionCacheValue<T>(map: Map<string, T>, sessionKey: string, value: T): void {
  map.delete(sessionKey);
  map.set(sessionKey, value);
  pruneMapToMaxSize(map, MAX_CACHED_CHAT_SESSIONS);
}

export function getOrCreateSessionCacheValue<T>(
  map: Map<string, T>,
  sessionKey: string,
  create: () => T,
): T {
  if (map.has(sessionKey)) {
    return getSessionCacheValue(map, sessionKey) as T;
  }

  const created = create();
  setSessionCacheValue(map, sessionKey, created);
  return created;
}
