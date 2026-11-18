import type { SessionStateActorType, SessionStateEventKind } from "./session-state-event-kinds.js";

export type SessionStateSweepAddress = {
  watcherSessionKey: string;
  targetSessionKey: string;
  watcherStorePath: string | null;
};

export type SessionStateEventRecord = {
  sequence: number;
  sessionKey: string;
  sessionId?: string;
  agentId: string;
  kind: SessionStateEventKind;
  actorType: SessionStateActorType;
  actorId?: string;
  runId?: string;
  occurredAt: number;
  summary: string;
  payload?: Record<string, unknown>;
};
