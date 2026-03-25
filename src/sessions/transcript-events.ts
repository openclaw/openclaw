export type SessionTranscriptUpdate = {
  sessionFile: string;
  sessionKey?: string;
  message?: unknown;
  messageId?: string;
};

type SessionTranscriptListener = (update: SessionTranscriptUpdate) => void;

const SESSION_TRANSCRIPT_LISTENERS = new Set<SessionTranscriptListener>();

/** Monotonic counter bumped on every transcript update emission; used to invalidate caches that depend on transcript state. */
let transcriptWriteGeneration = 0;

/** Returns the current transcript write generation (monotonic). */
export function getTranscriptWriteGeneration(): number {
  return transcriptWriteGeneration;
}

export function onSessionTranscriptUpdate(listener: SessionTranscriptListener): () => void {
  SESSION_TRANSCRIPT_LISTENERS.add(listener);
  return () => {
    SESSION_TRANSCRIPT_LISTENERS.delete(listener);
  };
}

export function emitSessionTranscriptUpdate(update: string | SessionTranscriptUpdate): void {
  const normalized =
    typeof update === "string"
      ? { sessionFile: update }
      : {
          sessionFile: update.sessionFile,
          sessionKey: update.sessionKey,
          message: update.message,
          messageId: update.messageId,
        };
  const trimmed = normalized.sessionFile.trim();
  if (!trimmed) {
    return;
  }
  const nextUpdate: SessionTranscriptUpdate = {
    sessionFile: trimmed,
    ...(typeof normalized.sessionKey === "string" && normalized.sessionKey.trim()
      ? { sessionKey: normalized.sessionKey.trim() }
      : {}),
    ...(normalized.message !== undefined ? { message: normalized.message } : {}),
    ...(typeof normalized.messageId === "string" && normalized.messageId.trim()
      ? { messageId: normalized.messageId.trim() }
      : {}),
  };
  transcriptWriteGeneration += 1;
  for (const listener of SESSION_TRANSCRIPT_LISTENERS) {
    try {
      listener(nextUpdate);
    } catch {
      /* ignore */
    }
  }
}
