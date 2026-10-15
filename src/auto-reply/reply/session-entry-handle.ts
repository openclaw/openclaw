import type { SessionEntry } from "../../config/sessions.js";

export type ReplySessionEntryHandle = {
  adoptCurrent(entry: SessionEntry): void;
  clearCurrent(): void;
  get(sessionKey: string): SessionEntry | undefined;
  getCurrent(): SessionEntry | undefined;
  replaceCurrent(entry: SessionEntry): void;
  toCompatSessionStore(): Record<string, SessionEntry>;
};

export class ReplySessionGenerationInvalidatedError extends Error {}

export function publishReplySessionEntry(
  params: {
    sessionEntryHandle?: ReplySessionEntryHandle;
    sessionStore?: Record<string, SessionEntry>;
    sessionKey?: string;
  },
  entry: SessionEntry | undefined,
): void {
  if (entry) {
    if (params.sessionEntryHandle) {
      params.sessionEntryHandle.replaceCurrent(entry);
    } else if (params.sessionStore && params.sessionKey) {
      params.sessionStore[params.sessionKey] = entry;
    }
  } else {
    params.sessionEntryHandle?.clearCurrent();
    if (params.sessionStore && params.sessionKey) {
      delete params.sessionStore[params.sessionKey];
    }
  }
}

export function createReplySessionEntryHandle(params: {
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  sessionStore?: Record<string, SessionEntry>;
  generationFence?: {
    sessionId: string;
    expectedStoreEntry?: SessionEntry;
  };
}): ReplySessionEntryHandle {
  const { generationFence, sessionKey, sessionStore } = params;
  const entries = sessionStore ?? {};
  let ownedSessionId = generationFence?.sessionId;
  let ownedLifecycleRevision =
    params.sessionEntry && params.sessionEntry.sessionId === ownedSessionId
      ? params.sessionEntry.lifecycleRevision
      : undefined;
  const matchesGeneration = (entry: SessionEntry | undefined): entry is SessionEntry =>
    entry !== undefined &&
    (!generationFence ||
      (entry.sessionId === ownedSessionId && entry.lifecycleRevision === ownedLifecycleRevision));
  let currentEntry = matchesGeneration(params.sessionEntry) ? params.sessionEntry : undefined;

  if (sessionKey && currentEntry) {
    const storedEntry = entries[sessionKey];
    if (
      !generationFence ||
      !sessionStore ||
      (storedEntry &&
        (storedEntry === generationFence.expectedStoreEntry || matchesGeneration(storedEntry)) &&
        (!matchesGeneration(storedEntry) || currentEntry.updatedAt >= storedEntry.updatedAt))
    ) {
      entries[sessionKey] = currentEntry;
    }
  }

  const current = (): SessionEntry | undefined => {
    const storedEntry = sessionKey ? entries[sessionKey] : undefined;
    if (
      generationFence &&
      matchesGeneration(storedEntry) &&
      (!matchesGeneration(currentEntry) || storedEntry.updatedAt >= currentEntry.updatedAt)
    ) {
      currentEntry = storedEntry;
    }
    return currentEntry;
  };

  const replaceCurrent = (entry: SessionEntry, adopt = false): void => {
    const storedEntry = sessionKey ? entries[sessionKey] : undefined;
    if (adopt && generationFence) {
      const storedMatchesAdopted =
        storedEntry?.sessionId === entry.sessionId &&
        storedEntry.lifecycleRevision === entry.lifecycleRevision;
      if (
        (sessionStore && sessionKey && !storedEntry && generationFence.expectedStoreEntry) ||
        (storedEntry && !matchesGeneration(storedEntry) && !storedMatchesAdopted)
      ) {
        throw new ReplySessionGenerationInvalidatedError(
          "Follow-up session generation was replaced during admission",
        );
      }
      ownedSessionId = entry.sessionId;
      ownedLifecycleRevision = entry.lifecycleRevision;
    }
    if (!matchesGeneration(entry)) {
      return;
    }
    const latest = current();
    currentEntry =
      generationFence && matchesGeneration(latest) && latest.updatedAt > entry.updatedAt
        ? latest
        : entry;
    if (
      sessionKey &&
      (!generationFence ||
        adopt ||
        (!storedEntry && !generationFence.expectedStoreEntry) ||
        matchesGeneration(storedEntry))
    ) {
      entries[sessionKey] = currentEntry;
    }
  };

  const handle: ReplySessionEntryHandle = {
    adoptCurrent: (entry) => replaceCurrent(entry, true),
    clearCurrent: () => {
      currentEntry = undefined;
      if (sessionKey && (!generationFence || matchesGeneration(entries[sessionKey]))) {
        delete entries[sessionKey];
      }
    },
    get: (key) => entries[key],
    getCurrent: current,
    replaceCurrent,
    toCompatSessionStore: () => {
      if (!generationFence || !sessionKey) {
        return entries;
      }
      // Legacy preflight writers must publish through the same session owner.
      return new Proxy(
        { ...entries },
        {
          get: (target, key) => (key === sessionKey ? current() : Reflect.get(target, key)),
          set(target, key, entry: SessionEntry | undefined) {
            if (key !== sessionKey) {
              return Reflect.set(target, key, entry);
            }
            if (entry) {
              replaceCurrent(entry, !matchesGeneration(entry));
            } else {
              handle.clearCurrent();
            }
            return true;
          },
          deleteProperty(target, key) {
            if (key !== sessionKey) {
              return Reflect.deleteProperty(target, key);
            }
            handle.clearCurrent();
            return true;
          },
        },
      );
    },
  };

  return handle;
}
