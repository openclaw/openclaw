import { loadConfig } from "../../config/config.js";
import { loadSessionStore, type SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, resolveGatewaySessionStoreTarget } from "../../gateway/session-utils.js";

export function loadCanonicalLatestSessionEntry(params: {
  sessionKey?: string;
  storePath?: string;
}): {
  entry?: SessionEntry;
  canonicalKey?: string;
  storeKeys: string[];
} {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return { storeKeys: [] };
  }

  if (params.storePath) {
    const cfg = loadConfig();
    const latestStore = loadSessionStore(params.storePath, { skipCache: true });
    const target = resolveGatewaySessionStoreTarget({
      cfg,
      key: sessionKey,
      store: latestStore,
    });
    for (const candidate of target.storeKeys) {
      const entry = latestStore[candidate];
      if (entry) {
        return {
          entry,
          canonicalKey: target.canonicalKey,
          storeKeys: target.storeKeys,
        };
      }
    }
  }

  const resolved = loadSessionEntry(sessionKey);
  return {
    entry: resolved.entry,
    canonicalKey: resolved.canonicalKey,
    storeKeys: [resolved.canonicalKey, resolved.legacyKey, sessionKey].filter(
      (value): value is string => Boolean(value),
    ),
  };
}

export function cacheResolvedSessionEntry(
  sessionStore: Record<string, SessionEntry> | undefined,
  entry: SessionEntry | undefined,
  keys: Iterable<string>,
) {
  if (!sessionStore || !entry) {
    return;
  }
  for (const candidate of keys) {
    const key = candidate?.trim();
    if (!key) {
      continue;
    }
    sessionStore[key] = entry;
  }
}
