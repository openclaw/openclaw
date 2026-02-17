type SessionTranscriptUpdate = {
  sessionFile: string;
};

type SessionTranscriptListener = (update: SessionTranscriptUpdate) => void;

const SESSION_TRANSCRIPT_LISTENERS = new Set<SessionTranscriptListener>();

/**
 * Register a listener for session transcript updates.
 * Returns an unsubscribe function. Listeners are guarded with try/catch
 * so a throwing subscriber cannot prevent other listeners from firing.
 *
 * @param listener - Callback invoked with the updated session file path.
 * @returns Unsubscribe function; call it to remove the listener.
 */
export function onSessionTranscriptUpdate(listener: SessionTranscriptListener): () => void {
  SESSION_TRANSCRIPT_LISTENERS.add(listener);
  return () => {
    SESSION_TRANSCRIPT_LISTENERS.delete(listener);
  };
}

export function emitSessionTranscriptUpdate(sessionFile: string): void {
  const trimmed = sessionFile.trim();
  if (!trimmed) {
    return;
  }
  const update = { sessionFile: trimmed };
  for (const listener of SESSION_TRANSCRIPT_LISTENERS) {
    try {
      listener(update);
    } catch {
      /* ignore */
    }
  }
}
