// Gateway Talk relay session lifecycle helpers.
// Enforces TTL and connection ownership for process-local relay sessions.
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";

/**
 * Shared TTL and connection-ownership checks for Talk relay session maps.
 */
type TalkRelayLifecycleSession = {
  connId: string;
  expiresAtMs: number;
};

type CloseTalkRelaySession<TSession extends TalkRelayLifecycleSession> = (
  session: TSession,
) => void;

function isExpiredTalkRelaySession(
  session: TalkRelayLifecycleSession,
  validNowMs: number,
): boolean {
  const expiresAtMs = asDateTimestampMs(session.expiresAtMs);
  return expiresAtMs === undefined || validNowMs > expiresAtMs;
}

/** Closes every expired relay session in the provided process-local map. */
export function closeExpiredTalkRelaySessions<TSession extends TalkRelayLifecycleSession>(params: {
  sessions: Iterable<TSession>;
  closeSession: CloseTalkRelaySession<TSession>;
  nowMs?: number;
}): void {
  const validNowMs = asDateTimestampMs(params.nowMs ?? Date.now());
  if (validNowMs === undefined) {
    return;
  }
  for (const session of params.sessions) {
    if (isExpiredTalkRelaySession(session, validNowMs)) {
      params.closeSession(session);
    }
  }
}

/** Closes every relay session owned by a disconnected gateway connection. */
export async function closeTalkRelaySessionsForConnection<
  TSession extends TalkRelayLifecycleSession,
>(params: {
  sessions: Iterable<TSession>;
  connId: string;
  closeSession: (session: TSession) => void | Promise<void>;
  onCloseError: (error: unknown, session: TSession) => void;
}): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const session of params.sessions) {
    if (session.connId !== params.connId) {
      continue;
    }
    try {
      const completion = params.closeSession(session);
      if (completion) {
        pending.push(completion);
      }
    } catch (error) {
      params.onCloseError(error, session);
    }
  }
  const results = await Promise.allSettled(pending);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "Talk relay cleanup did not complete");
  }
}

/** Returns the active session only when it belongs to the current connection. */
export function requireActiveTalkRelaySession<TSession extends TalkRelayLifecycleSession>(params: {
  sessions: ReadonlyMap<string, TSession>;
  sessionId: string;
  connId: string;
  closeSession: CloseTalkRelaySession<TSession>;
  unknownSessionMessage: string;
}): TSession {
  const session = params.sessions.get(params.sessionId);
  if (!session || session.connId !== params.connId) {
    throw new Error(params.unknownSessionMessage);
  }
  const nowMs = asDateTimestampMs(Date.now());
  if (nowMs === undefined || isExpiredTalkRelaySession(session, nowMs)) {
    params.closeSession(session);
    throw new Error(params.unknownSessionMessage);
  }
  return session;
}
