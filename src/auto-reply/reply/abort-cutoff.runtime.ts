import { resolveSessionStoreEntry, updateSessionStore } from "../../config/sessions/store.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { applyAbortCutoffToSessionEntry, hasAbortCutoff } from "./abort-cutoff.js";

export async function clearAbortCutoffInSessionRuntime(params: {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
}): Promise<boolean> {
  const { sessionEntry, sessionStore, sessionKey, storePath } = params;
  if (!sessionEntry || !sessionStore || !sessionKey || !hasAbortCutoff(sessionEntry)) {
    return false;
  }

  applyAbortCutoffToSessionEntry(sessionEntry, undefined);
  sessionEntry.updatedAt = Date.now();
  {
    const memResolved = resolveSessionStoreEntry({ store: sessionStore, sessionKey });
    sessionStore[memResolved.normalizedKey] = sessionEntry;
    for (const legacyKey of memResolved.legacyKeys) {
      delete sessionStore[legacyKey];
    }
  }

  if (storePath) {
    await updateSessionStore(storePath, (store) => {
      const resolved = resolveSessionStoreEntry({ store, sessionKey });
      const existing = resolved.existing ?? sessionEntry;
      if (!existing) {
        return;
      }
      applyAbortCutoffToSessionEntry(existing, undefined);
      existing.updatedAt = Date.now();
      store[resolved.normalizedKey] = existing;
      for (const legacyKey of resolved.legacyKeys) {
        delete store[legacyKey];
      }
    });
  }

  return true;
}
