import type { SessionEntry } from "../../config/sessions.js";

export type ReplySessionEntryHandle = {
  clearCurrent(): void;
  get(sessionKey: string): SessionEntry | undefined;
  getCurrent(): SessionEntry | undefined;
  replaceCurrent(entry: SessionEntry): void;
  toCompatSessionStore(): Record<string, SessionEntry>;
};

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
}): ReplySessionEntryHandle {
  const { sessionKey, sessionStore } = params;
  const entries = sessionStore ?? {};
  let currentEntry = params.sessionEntry;
  if (sessionKey) {
    if (currentEntry) {
      entries[sessionKey] = currentEntry;
    } else {
      delete entries[sessionKey];
    }
  }
  const replaceCurrent = (entry: SessionEntry): void => {
    currentEntry = entry;
    if (sessionKey) {
      entries[sessionKey] = entry;
    }
  };
  return {
    clearCurrent: () => {
      currentEntry = undefined;
      if (sessionKey) {
        delete entries[sessionKey];
      }
    },
    get: (key) => entries[key],
    getCurrent: () => (sessionKey ? entries[sessionKey] : currentEntry),
    replaceCurrent,
    toCompatSessionStore: () => entries,
  };
}
