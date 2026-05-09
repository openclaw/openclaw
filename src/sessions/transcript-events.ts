import { normalizeOptionalString } from "../shared/string-coerce.js";

export type SessionTranscriptUpdate = {
  agentId?: string;
  sessionId?: string;
  transcriptLocator?: string;
  sessionKey?: string;
  message?: unknown;
  messageId?: string;
};

type SessionTranscriptListener = (update: SessionTranscriptUpdate) => void;

const SESSION_TRANSCRIPT_LISTENERS = new Set<SessionTranscriptListener>();

export function onSessionTranscriptUpdate(listener: SessionTranscriptListener): () => void {
  SESSION_TRANSCRIPT_LISTENERS.add(listener);
  return () => {
    SESSION_TRANSCRIPT_LISTENERS.delete(listener);
  };
}

export function emitSessionTranscriptUpdate(update: SessionTranscriptUpdate): void {
  const normalized = {
    agentId: update.agentId,
    sessionId: update.sessionId,
    transcriptLocator: update.transcriptLocator,
    sessionKey: update.sessionKey,
    message: update.message,
    messageId: update.messageId,
  };
  const trimmed = normalizeOptionalString(normalized.transcriptLocator);
  const agentId = normalizeOptionalString(normalized.agentId);
  const sessionId = normalizeOptionalString(normalized.sessionId);
  const sessionKey = normalizeOptionalString(normalized.sessionKey);
  if (!trimmed && !sessionId && !sessionKey) {
    return;
  }
  const nextUpdate: SessionTranscriptUpdate = {
    ...(agentId ? { agentId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(trimmed ? { transcriptLocator: trimmed } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(normalized.message !== undefined ? { message: normalized.message } : {}),
    ...(normalizeOptionalString(normalized.messageId)
      ? { messageId: normalizeOptionalString(normalized.messageId) }
      : {}),
  };
  for (const listener of SESSION_TRANSCRIPT_LISTENERS) {
    try {
      listener(nextUpdate);
    } catch {
      /* ignore */
    }
  }
}
