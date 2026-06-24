// Narrow mutable handle for the active reply session entry.
import type { SessionEntry } from "../../config/sessions.js";

export type ReplySessionEntryHandle = {
  get(sessionKey: string): SessionEntry | undefined;
  getCurrent(): SessionEntry | undefined;
  patchCurrent(patch: Partial<SessionEntry>): SessionEntry | undefined;
  replaceCurrent(entry: SessionEntry): void;
  set(sessionKey: string, entry: SessionEntry): void;
  toCompatSessionStore(): Record<string, SessionEntry>;
};

export function createReplySessionEntryHandle(params: {
  sessionEntry: SessionEntry;
  sessionKey: string;
  sessionStore?: Record<string, SessionEntry>;
}): ReplySessionEntryHandle {
  const entries = params.sessionStore ?? { [params.sessionKey]: params.sessionEntry };
  let currentEntry = params.sessionEntry;
  entries[params.sessionKey] = currentEntry;

  return {
    get: (sessionKey) => entries[sessionKey],
    getCurrent: () => currentEntry,
    patchCurrent: (patch) => {
      currentEntry = { ...currentEntry, ...patch };
      entries[params.sessionKey] = currentEntry;
      return currentEntry;
    },
    replaceCurrent: (entry) => {
      currentEntry = entry;
      entries[params.sessionKey] = entry;
    },
    set: (sessionKey, entry) => {
      entries[sessionKey] = entry;
      if (sessionKey === params.sessionKey) {
        currentEntry = entry;
      }
    },
    toCompatSessionStore: () => entries,
  };
}
