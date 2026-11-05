import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { resolveUserStoppedAt } from "../../config/sessions/terminal-status.js";
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
  const updatedAt = Date.now();
  sessionEntry.updatedAt = updatedAt;
  sessionStore[sessionKey] = sessionEntry;

  if (storePath) {
    await patchSessionEntryCore(
      { storePath, sessionKey },
      () => ({
        abortCutoffMessageSid: undefined,
        abortCutoffTimestamp: undefined,
        updatedAt,
      }),
      { fallbackEntry: sessionEntry },
    );
  }

  return true;
}

/**
 * Claims the Stop a reply prompt may state (read before any await), never a newer one: true only
 * for the caller whose write retired it, so one prompt says it.
 */
export async function clearUserStopInSessionRuntime(params: {
  sessionId: string;
  stoppedAt: number;
  sessionEntry: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
}): Promise<boolean> {
  const { sessionId, stoppedAt, sessionEntry, sessionStore, sessionKey, storePath } = params;
  const stated = (entry: SessionEntry) =>
    entry.sessionId === sessionId && resolveUserStoppedAt(entry) === stoppedAt;
  const retired = { userStoppedAt: undefined, userStoppedSessionId: undefined };
  // The map may hold another object by now; each copy clears only if it still holds this Stop.
  let claimed = stated(sessionEntry);
  for (const entry of [sessionEntry, sessionKey ? sessionStore?.[sessionKey] : undefined]) {
    if (entry && stated(entry)) {
      Object.assign(entry, retired);
    }
  }
  if (storePath && sessionKey) {
    // The durable row decides: its serialized write retires the Stop for exactly one caller, and
    // a missing row retires nothing.
    claimed = false;
    await patchSessionEntryCore({ storePath, sessionKey }, (current) => {
      claimed = stated(current);
      return claimed ? retired : null;
    });
  }
  return claimed;
}
