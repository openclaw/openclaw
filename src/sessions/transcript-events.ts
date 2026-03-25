type SessionTranscriptUpdate = {
  sessionFile: string;
  sessionKey?: string;
  message?: unknown;
};

type SessionTranscriptListener = (update: SessionTranscriptUpdate) => void;

const SESSION_TRANSCRIPT_LISTENERS = new Set<SessionTranscriptListener>();

export function onSessionTranscriptUpdate(listener: SessionTranscriptListener): () => void {
  SESSION_TRANSCRIPT_LISTENERS.add(listener);
  return () => {
    SESSION_TRANSCRIPT_LISTENERS.delete(listener);
  };
}

export function emitSessionTranscriptUpdate(input: string | SessionTranscriptUpdate): void {
  const update: SessionTranscriptUpdate =
    typeof input === "string" ? { sessionFile: input.trim() } : { ...input, sessionFile: input.sessionFile.trim() };
  if (!update.sessionFile) {
    return;
  }
  for (const listener of SESSION_TRANSCRIPT_LISTENERS) {
    try {
      listener(update);
    } catch {
      /* ignore */
    }
  }
}
