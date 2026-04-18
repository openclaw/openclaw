import { resolveSessionStoreEntry } from "./store-entry.js";
import { loadSessionStore } from "./store-load.js";
import type { SessionEntry } from "./types.js";

export { loadSessionStore } from "./store-load.js";

export function readSessionStoreReadOnly(storePath: string): Record<string, SessionEntry> {
  return loadSessionStore(storePath);
}

export function readSessionUpdatedAt(params: {
  storePath: string;
  sessionKey: string;
}): number | undefined {
  try {
    const store = loadSessionStore(params.storePath);
    const resolved = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey });
    return resolved.existing?.updatedAt;
  } catch {
    return undefined;
  }
}
