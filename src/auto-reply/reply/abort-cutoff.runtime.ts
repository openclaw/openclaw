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
 * Claims the Stop recorded on the reply's session row, never a newer one: true only for the caller
 * whose write retired it, so one admitted turn states it.
 */
export async function claimUserStopInSessionRuntime(params: {
  /** The reply's agent: a key without one (`global`) cannot name the store the Stop was recorded in. */
  agentId: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
}): Promise<boolean> {
  const { agentId, sessionEntry, sessionStore, sessionKey, storePath } = params;
  const stoppedAt = resolveUserStoppedAt(sessionEntry);
  if (!sessionEntry || stoppedAt === undefined) {
    return false;
  }
  const { sessionId } = sessionEntry;
  const stated = (entry: SessionEntry) =>
    entry.sessionId === sessionId && resolveUserStoppedAt(entry) === stoppedAt;
  const retired = { userStoppedAt: undefined, userStoppedSessionId: undefined };
  // The map may hold another object by now; each copy clears only if it still holds this Stop.
  for (const entry of [sessionEntry, sessionKey ? sessionStore?.[sessionKey] : undefined]) {
    if (entry && stated(entry)) {
      Object.assign(entry, retired);
    }
  }
  if (!storePath || !sessionKey) {
    return true;
  }
  // The durable row decides: its serialized write retires the Stop for exactly one caller, and
  // a missing row retires nothing.
  let claimed = false;
  await patchSessionEntryCore({ agentId, storePath, sessionKey }, (current) => {
    claimed = stated(current);
    return claimed ? retired : null;
  });
  return claimed;
}
