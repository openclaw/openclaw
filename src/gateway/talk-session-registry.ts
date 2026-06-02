export type UnifiedTalkSessionRecord =
  | {
      /** Realtime voice relay session owned by one Gateway connection. */
      kind: "realtime-relay";
      /** Owning Gateway connection id. */
      connId: string;
      /** Realtime relay session id. */
      relaySessionId: string;
    }
  | {
      /** Realtime transcription relay session owned by one Gateway connection. */
      kind: "transcription-relay";
      /** Owning Gateway connection id. */
      connId: string;
      /** Transcription relay session id. */
      transcriptionSessionId: string;
    }
  | {
      /** Managed browser room created from a talk handoff. */
      kind: "managed-room";
      /** Handoff id used to look up the room. */
      handoffId: string;
      /** Plaintext handoff token retained for server-side room actions. */
      token: string;
      /** Managed room id exposed to clients. */
      roomId: string;
    };

const unifiedTalkSessions = new Map<string, UnifiedTalkSessionRecord>();

/** Register a Talk session id with the backing transport-specific session. */
export function rememberUnifiedTalkSession(
  sessionId: string,
  session: UnifiedTalkSessionRecord,
): void {
  unifiedTalkSessions.set(sessionId, session);
}

/** Resolve a Talk session id to its backing transport-specific session. */
export function getUnifiedTalkSession(sessionId: string): UnifiedTalkSessionRecord {
  const session = unifiedTalkSessions.get(sessionId);
  if (!session) {
    throw new Error("Unknown Talk session");
  }
  return session;
}

/** Remove a Talk session id after its backing session closes. */
export function forgetUnifiedTalkSession(sessionId: string): void {
  unifiedTalkSessions.delete(sessionId);
}

/** Validate that a connection-owned Talk session is being controlled by its owner. */
export function requireUnifiedTalkSessionConn(
  session: Extract<UnifiedTalkSessionRecord, { connId: string }>,
  connId: string | undefined,
): string {
  if (!connId || session.connId !== connId) {
    throw new Error("Talk session is not owned by this connection");
  }
  return connId;
}

/** Clear all unified Talk session mappings for test isolation. */
export function clearUnifiedTalkSessionsForTest(): void {
  unifiedTalkSessions.clear();
}
