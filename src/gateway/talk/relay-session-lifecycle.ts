const MAX_RELAY_SESSIONS_PER_CONN = 2;
const MAX_RELAY_SESSIONS_GLOBAL = 64;

type TalkRelayLifecycleSession = {
  connId: string;
  expiresAtMs: number;
};

type CloseTalkRelaySession<TSession extends TalkRelayLifecycleSession> = (
  session: TSession,
) => void;

export function assertTalkRelaySessionCapacity(
  sessions: readonly Pick<TalkRelayLifecycleSession, "connId">[],
  connId: string,
  label: "realtime relay" | "transcription Talk",
): void {
  if (sessions.length >= MAX_RELAY_SESSIONS_GLOBAL) {
    throw new Error(`Too many active ${label} sessions`);
  }
  if (
    sessions.filter((session) => session.connId === connId).length >= MAX_RELAY_SESSIONS_PER_CONN
  ) {
    throw new Error(`Too many active ${label} sessions for this connection`);
  }
}

export function closeExpiredTalkRelaySessions<TSession extends TalkRelayLifecycleSession>(params: {
  sessions: Iterable<TSession>;
  closeSession: CloseTalkRelaySession<TSession>;
}): void {
  const now = Date.now();
  for (const session of params.sessions) {
    if (now > session.expiresAtMs) {
      params.closeSession(session);
    }
  }
}

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
  if (Date.now() > session.expiresAtMs) {
    params.closeSession(session);
    throw new Error(params.unknownSessionMessage);
  }
  return session;
}
