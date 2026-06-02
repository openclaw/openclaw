import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/**
 * In-process transcript mutation notification consumed by Gateway websocket
 * fanout, session history, and transcript index refresh paths. `sessionFile` is
 * required because archive and append events can be resolved from the file path
 * even when the session key is not provided.
 */
export type SessionTranscriptUpdate = {
  sessionFile: string;
  sessionKey?: string;
  agentId?: string;
  message?: unknown;
  messageId?: string;
  messageSeq?: number;
};

type SessionTranscriptListener = (update: SessionTranscriptUpdate) => void;

const SESSION_TRANSCRIPT_LISTENERS = new Set<SessionTranscriptListener>();

/**
 * Registers a transcript update listener and returns its unsubscribe function.
 * The bus is process-local; callers that install long-lived listeners should
 * unregister them during teardown.
 */
export function onSessionTranscriptUpdate(listener: SessionTranscriptListener): () => void {
  SESSION_TRANSCRIPT_LISTENERS.add(listener);
  return () => {
    SESSION_TRANSCRIPT_LISTENERS.delete(listener);
  };
}

/**
 * Emits a normalized transcript update. String inputs are shorthand for a file
 * path-only mutation, and object inputs preserve optional session/message
 * metadata for websocket subscribers.
 */
export function emitSessionTranscriptUpdate(update: string | SessionTranscriptUpdate): void {
  const normalized =
    typeof update === "string"
      ? { sessionFile: update }
      : {
          sessionFile: update.sessionFile,
          sessionKey: update.sessionKey,
          agentId: update.agentId,
          message: update.message,
          messageId: update.messageId,
          messageSeq: update.messageSeq,
        };
  const trimmed = normalizeOptionalString(normalized.sessionFile);
  if (!trimmed) {
    return;
  }
  const messageSeq = asPositiveSafeInteger(normalized.messageSeq);
  // Normalize before fanout so listeners can treat blank strings and invalid
  // sequence numbers as absent rather than repeating validation work.
  const nextUpdate: SessionTranscriptUpdate = {
    sessionFile: trimmed,
    ...(normalizeOptionalString(normalized.sessionKey)
      ? { sessionKey: normalizeOptionalString(normalized.sessionKey) }
      : {}),
    ...(normalizeOptionalString(normalized.agentId)
      ? { agentId: normalizeOptionalString(normalized.agentId) }
      : {}),
    ...(normalized.message !== undefined ? { message: normalized.message } : {}),
    ...(normalizeOptionalString(normalized.messageId)
      ? { messageId: normalizeOptionalString(normalized.messageId) }
      : {}),
    ...(messageSeq !== undefined ? { messageSeq } : {}),
  };
  for (const listener of SESSION_TRANSCRIPT_LISTENERS) {
    try {
      listener(nextUpdate);
    } catch {
      /* ignore */
    }
  }
}
