// Transcript event helpers serialize and trim session transcript events.
import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
<<<<<<< HEAD
import { parseAgentSessionKey } from "../routing/session-key.js";

/** Storage-neutral identity for the session transcript that changed. */
export type SessionTranscriptUpdateTarget = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
};

type SessionTranscriptUpdateFields = {
  sessionFile?: string;
  target?: SessionTranscriptUpdateTarget;
  sessionKey?: string;
  agentId?: string;
  /** @deprecated Pre-SQLite compatibility mirror. Prefer `target.sessionId`. */
  sessionId?: string;
=======

/** Normalized transcript update emitted after a session transcript changes. */
export type SessionTranscriptUpdate = {
  sessionFile: string;
  sessionKey?: string;
  agentId?: string;
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  message?: unknown;
  messageId?: string;
  messageSeq?: number;
};

<<<<<<< HEAD
/** Normalized transcript update emitted after a session transcript changes. */
export type SessionTranscriptUpdate = SessionTranscriptUpdateFields & {
  /** @deprecated File-backed compatibility hint. Prefer `target` for identity. */
  sessionFile: string;
};

/** Internal transcript update that may identify a transcript without a file path. */
export type InternalSessionTranscriptUpdate = SessionTranscriptUpdateFields;

type SessionTranscriptListener = (update: SessionTranscriptUpdate) => void;
type InternalSessionTranscriptListener = (update: InternalSessionTranscriptUpdate) => void;

const SESSION_TRANSCRIPT_LISTENERS = new Set<SessionTranscriptListener>();
const INTERNAL_SESSION_TRANSCRIPT_LISTENERS = new Set<InternalSessionTranscriptListener>();
=======
type SessionTranscriptListener = (update: SessionTranscriptUpdate) => void;

const SESSION_TRANSCRIPT_LISTENERS = new Set<SessionTranscriptListener>();
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

/** Registers a listener for normalized session transcript updates. */
export function onSessionTranscriptUpdate(listener: SessionTranscriptListener): () => void {
  SESSION_TRANSCRIPT_LISTENERS.add(listener);
  return () => {
    SESSION_TRANSCRIPT_LISTENERS.delete(listener);
  };
}

<<<<<<< HEAD
/** Registers an internal listener for identity-only or file-backed transcript updates. */
export function onInternalSessionTranscriptUpdate(
  listener: InternalSessionTranscriptListener,
): () => void {
  INTERNAL_SESSION_TRANSCRIPT_LISTENERS.add(listener);
  return () => {
    INTERNAL_SESSION_TRANSCRIPT_LISTENERS.delete(listener);
  };
}

/** Emits a normalized transcript update to all registered listeners. */
export function emitSessionTranscriptUpdate(update: string | SessionTranscriptUpdate): void {
  const nextUpdate = normalizeSessionTranscriptUpdate(update, { allowIdentityOnly: false });
  if (!nextUpdate?.sessionFile) {
    return;
  }
  emitPublicSessionTranscriptUpdate(nextUpdate as SessionTranscriptUpdate);
  emitInternalTranscriptUpdate(nextUpdate);
}

/** Emits an internal transcript update, including identity-only updates. */
export function emitInternalSessionTranscriptUpdate(update: InternalSessionTranscriptUpdate): void {
  const nextUpdate = normalizeSessionTranscriptUpdate(update, { allowIdentityOnly: true });
  if (!nextUpdate) {
    return;
  }
  emitInternalTranscriptUpdate(nextUpdate);
}

function normalizeSessionTranscriptUpdate(
  update: string | InternalSessionTranscriptUpdate,
  options: { allowIdentityOnly: boolean },
): InternalSessionTranscriptUpdate | undefined {
  // Public callers still need a file-backed update, while internal callers can
  // carry identity-only updates during the pre-SQLite transition.
=======
/** Emits a normalized transcript update to all registered listeners. */
export function emitSessionTranscriptUpdate(update: string | SessionTranscriptUpdate): void {
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  const normalized =
    typeof update === "string"
      ? { sessionFile: update }
      : {
          sessionFile: update.sessionFile,
<<<<<<< HEAD
          target: update.target,
          sessionKey: update.sessionKey,
          agentId: update.agentId,
          sessionId: update.sessionId,
=======
          sessionKey: update.sessionKey,
          agentId: update.agentId,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
          message: update.message,
          messageId: update.messageId,
          messageSeq: update.messageSeq,
        };
  const trimmed = normalizeOptionalString(normalized.sessionFile);
<<<<<<< HEAD
  const target = normalizeUpdateTarget(normalized);
  if (!trimmed && (!options.allowIdentityOnly || !target)) {
    return undefined;
  }
  const messageSeq = asPositiveSafeInteger(normalized.messageSeq);
  const sessionKey = normalizeOptionalString(normalized.sessionKey) ?? target?.sessionKey;
  const agentId = normalizeOptionalString(normalized.agentId) ?? target?.agentId;
  const sessionId = normalizeOptionalString(normalized.sessionId) ?? target?.sessionId;
  return {
    ...(trimmed ? { sessionFile: trimmed } : {}),
    ...(target ? { target } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(agentId ? { agentId } : {}),
    ...(sessionId ? { sessionId } : {}),
=======
  if (!trimmed) {
    return;
  }
  const messageSeq = asPositiveSafeInteger(normalized.messageSeq);
  const nextUpdate: SessionTranscriptUpdate = {
    sessionFile: trimmed,
    ...(normalizeOptionalString(normalized.sessionKey)
      ? { sessionKey: normalizeOptionalString(normalized.sessionKey) }
      : {}),
    ...(normalizeOptionalString(normalized.agentId)
      ? { agentId: normalizeOptionalString(normalized.agentId) }
      : {}),
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    ...(normalized.message !== undefined ? { message: normalized.message } : {}),
    ...(normalizeOptionalString(normalized.messageId)
      ? { messageId: normalizeOptionalString(normalized.messageId) }
      : {}),
    ...(messageSeq !== undefined ? { messageSeq } : {}),
  };
<<<<<<< HEAD
}

function emitPublicSessionTranscriptUpdate(nextUpdate: SessionTranscriptUpdate): void {
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  for (const listener of SESSION_TRANSCRIPT_LISTENERS) {
    try {
      listener(nextUpdate);
    } catch {
      /* ignore */
    }
  }
}
<<<<<<< HEAD

function emitInternalTranscriptUpdate(nextUpdate: InternalSessionTranscriptUpdate): void {
  for (const listener of INTERNAL_SESSION_TRANSCRIPT_LISTENERS) {
    try {
      listener(nextUpdate);
    } catch {
      /* ignore */
    }
  }
}

function normalizeUpdateTarget(update: {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  target?: SessionTranscriptUpdate["target"];
}): SessionTranscriptUpdateTarget | undefined {
  const sessionKey =
    normalizeOptionalString(update.target?.sessionKey) ??
    normalizeOptionalString(update.sessionKey);
  const agentId =
    normalizeOptionalString(update.target?.agentId) ??
    normalizeOptionalString(update.agentId) ??
    (sessionKey ? parseAgentSessionKey(sessionKey)?.agentId : undefined);
  const sessionId =
    normalizeOptionalString(update.target?.sessionId) ?? normalizeOptionalString(update.sessionId);
  if (!agentId || !sessionId || !sessionKey) {
    return undefined;
  }
  return {
    agentId,
    sessionId,
    sessionKey,
  };
}
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
