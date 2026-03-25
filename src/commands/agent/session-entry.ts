import type { SessionEntry } from "../../config/sessions.js";

/**
 * Normalize session ids by trimming whitespace and dropping empty values.
 * @param sessionId Raw session id supplied by callers or persisted state.
 * @returns Trimmed session id, or undefined when the input is empty after trimming.
 */
export function normalizeSessionId(sessionId: string | undefined): string | undefined {
  const trimmed = sessionId?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Drop persisted transcript paths when callers rotate to a different session id.
 * This keeps forced session-id runs from reusing transcripts from an older session.
 * @param entry Existing session entry that may still point at an older transcript.
 * @param sessionId Requested session id for the current run.
 * @returns The original entry, or a shallow copy with a stale sessionFile removed.
 */
export function removeStaleTranscriptPathForSessionId(
  entry: SessionEntry | undefined,
  sessionId: string,
): SessionEntry | undefined {
  const requestedSessionId = normalizeSessionId(sessionId);
  const storedSessionId = normalizeSessionId(entry?.sessionId);
  if (
    !entry ||
    !entry.sessionFile || // No persisted transcript path to clear.
    !requestedSessionId ||
    storedSessionId === requestedSessionId
  ) {
    return entry;
  }
  const { sessionFile: _staleSessionFile, ...next } = entry;
  return next;
}
