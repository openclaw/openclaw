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
 * Claims the Stop recorded on the session row, never a newer one: true only for the caller whose
 * serialized write retired it, so one turn states it. A missing row retires nothing; without a
 * store the caller's own copy decides.
 */
export async function claimUserStopInSessionRuntime(params: {
  /** The turn's agent: a key without one (`global`) cannot name the store the Stop was recorded in. */
  agentId: string;
  sessionEntry: SessionEntry;
  sessionKey?: string;
  storePath?: string;
}): Promise<boolean> {
  const { agentId, sessionEntry, sessionKey, storePath } = params;
  if (!holdsUserStopOf(sessionEntry, sessionEntry)) {
    return false;
  }
  if (!storePath || !sessionKey) {
    return true;
  }
  let claimed = false;
  await patchSessionEntryCore({ agentId, storePath, sessionKey }, (current) => {
    claimed = holdsUserStopOf(current, sessionEntry);
    return claimed ? { userStoppedAt: undefined, userStoppedSessionId: undefined } : null;
  });
  return claimed;
}

/** Whether `entry` still holds the Stop the turn read in `read`. */
export function holdsUserStopOf(entry: SessionEntry | undefined, read: SessionEntry): boolean {
  const stoppedAt = resolveUserStoppedAt(read);
  return (
    stoppedAt !== undefined &&
    entry?.sessionId === read.sessionId &&
    resolveUserStoppedAt(entry) === stoppedAt
  );
}
