import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseAgentSessionKey } from "../routing/session-key.js";

export type SessionTranscriptUpdateTarget = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  targetKind: "active-session-file" | "runtime-session";
};

type SessionTranscriptUpdateFields = {
  target?: SessionTranscriptUpdateTarget;
  sessionKey?: string;
  agentId?: string;
  /** @deprecated Pre-SQLite compatibility mirror. Prefer `target.sessionId`. */
  sessionId?: string;
  message?: unknown;
  messageId?: string;
  messageSeq?: number;
};

export type SessionTranscriptUpdate = SessionTranscriptUpdateFields & {
  /** @deprecated File-backed compatibility hint. Prefer `target` for identity. */
  sessionFile: string;
};

export type InternalSessionTranscriptUpdate = SessionTranscriptUpdateFields & {
  sessionFile?: string;
};

type SessionTranscriptListener = (update: SessionTranscriptUpdate) => void;
type InternalSessionTranscriptListener = (update: InternalSessionTranscriptUpdate) => void;

const SESSION_TRANSCRIPT_LISTENERS = new Set<SessionTranscriptListener>();
const INTERNAL_SESSION_TRANSCRIPT_LISTENERS = new Set<InternalSessionTranscriptListener>();

export function onSessionTranscriptUpdate(listener: SessionTranscriptListener): () => void {
  SESSION_TRANSCRIPT_LISTENERS.add(listener);
  return () => {
    SESSION_TRANSCRIPT_LISTENERS.delete(listener);
  };
}

export function onInternalSessionTranscriptUpdate(
  listener: InternalSessionTranscriptListener,
): () => void {
  INTERNAL_SESSION_TRANSCRIPT_LISTENERS.add(listener);
  return () => {
    INTERNAL_SESSION_TRANSCRIPT_LISTENERS.delete(listener);
  };
}

export function emitSessionTranscriptUpdate(update: string | SessionTranscriptUpdate): void {
  const nextUpdate = normalizeSessionTranscriptUpdate(update, { allowIdentityOnly: false });
  if (!nextUpdate?.sessionFile) {
    return;
  }
  emitPublicSessionTranscriptUpdate(nextUpdate as SessionTranscriptUpdate);
  emitInternalTranscriptUpdate(nextUpdate);
}

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
  const normalized =
    typeof update === "string"
      ? { sessionFile: update }
      : {
          sessionFile: update.sessionFile,
          target: update.target,
          sessionKey: update.sessionKey,
          agentId: update.agentId,
          sessionId: update.sessionId,
          message: update.message,
          messageId: update.messageId,
          messageSeq: update.messageSeq,
        };
  const trimmed = normalizeOptionalString(normalized.sessionFile);
  const target = normalizeUpdateTarget(normalized.target);
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
    ...(normalized.message !== undefined ? { message: normalized.message } : {}),
    ...(normalizeOptionalString(normalized.messageId)
      ? { messageId: normalizeOptionalString(normalized.messageId) }
      : {}),
    ...(messageSeq !== undefined ? { messageSeq } : {}),
  };
}

function emitPublicSessionTranscriptUpdate(nextUpdate: SessionTranscriptUpdate): void {
  for (const listener of SESSION_TRANSCRIPT_LISTENERS) {
    try {
      listener(nextUpdate);
    } catch {
      /* ignore */
    }
  }
}

function emitInternalTranscriptUpdate(nextUpdate: InternalSessionTranscriptUpdate): void {
  for (const listener of INTERNAL_SESSION_TRANSCRIPT_LISTENERS) {
    try {
      listener(nextUpdate);
    } catch {
      /* ignore */
    }
  }
}

function normalizeUpdateTarget(
  target: InternalSessionTranscriptUpdate["target"],
): SessionTranscriptUpdateTarget | undefined {
  const sessionKey = normalizeOptionalString(target?.sessionKey);
  const agentId =
    normalizeOptionalString(target?.agentId) ??
    (sessionKey ? parseAgentSessionKey(sessionKey)?.agentId : undefined);
  const sessionId = normalizeOptionalString(target?.sessionId);
  const targetKind = normalizeTargetKind(target?.targetKind);
  if (!agentId || !sessionId || !sessionKey || !targetKind) {
    return undefined;
  }
  return {
    agentId,
    sessionId,
    sessionKey,
    targetKind,
  };
}

function normalizeTargetKind(
  value: SessionTranscriptUpdateTarget["targetKind"] | undefined,
): SessionTranscriptUpdateTarget["targetKind"] | undefined {
  return value === "active-session-file" || value === "runtime-session" ? value : undefined;
}
