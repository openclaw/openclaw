import type {
  ContextEngineTurnOutboxPayload,
  ContextEngineTurnOutboxWorkerOperations,
} from "../../agents/harness/context-engine-turn-outbox.js";
import type { HeartbeatOutcomeRow } from "../../infra/heartbeat-outcome-store.kernel.js";
import type { HeartbeatOutcomeWorkerOperations } from "../../infra/heartbeat-outcome-store.worker.js";
import type { MessageToolRunOutcomeInsert } from "../../infra/message-tool-run-outcome-store.kernel.js";
import type {
  SqliteTrajectoryRuntimeAppend,
  SqliteTrajectoryRuntimeReadScope,
} from "../../trajectory/runtime-store.contract.js";
import type { TrajectoryEvent } from "../../trajectory/types.js";

type OutboxOperations = {
  [
    Key in keyof ContextEngineTurnOutboxWorkerOperations as `session.outbox.${Key}`
  ]: ContextEngineTurnOutboxWorkerOperations[Key];
};

export type SessionActorMemorySideEffectsReads = Pick<
  OutboxOperations,
  | "session.outbox.listPendingSessions"
  | "session.outbox.readNextPending"
  | "session.outbox.hasPending"
> & {
  "session.trajectory.read": {
    input: Omit<SqliteTrajectoryRuntimeReadScope, "agentId" | "env" | "storePath">;
    output: TrajectoryEvent[];
  };
  "session.trajectory.rows": {
    input: Omit<SqliteTrajectoryRuntimeReadScope, "agentId" | "env" | "storePath"> & {
      afterSeq?: number;
      maxEvents?: number;
      tailEvents?: number;
    };
    output: Array<{ event: TrajectoryEvent; seq: number }>;
  };
};

export type SessionActorMemorySideEffectsWrites = Omit<
  OutboxOperations,
  keyof SessionActorMemorySideEffectsReads
> & {
  "session.heartbeat.persist": HeartbeatOutcomeWorkerOperations["persist"];
  "session.heartbeat.claim": HeartbeatOutcomeWorkerOperations["claim"];
  "session.messageToolOutcome.record": { input: MessageToolRunOutcomeInsert; output: void };
  "session.trajectory.append": { input: SqliteTrajectoryRuntimeAppend; output: void };
};

export type SessionActorMemorySideEffectsQuery = {
  [Key in keyof SessionActorMemorySideEffectsReads]: {
    type: Key;
    input: SessionActorMemorySideEffectsReads[Key]["input"];
  };
}[keyof SessionActorMemorySideEffectsReads];
export type SessionActorMemorySideEffectsCommand = {
  [Key in keyof SessionActorMemorySideEffectsWrites]: {
    type: Key;
    input: SessionActorMemorySideEffectsWrites[Key]["input"];
  };
}[keyof SessionActorMemorySideEffectsWrites];

export type SessionActorMemoryOutboxRow = {
  engineId: string;
  ownerPluginId?: string;
  payload: ContextEngineTurnOutboxPayload;
  payloadJson: string;
  sessionId: string;
  attempts: number;
  lastAttemptAt?: number;
  lastError?: string;
};
export type SessionActorMemoryTrajectoryRow = {
  seq: number;
  eventJson: string;
  bytes: number;
  createdAt: number;
  runId: string | null;
};

/** These records belong to the logical session and survive transcript-window rotation. */
export type SessionActorMemorySideEffectsState = {
  outbox: Map<string, SessionActorMemoryOutboxRow>;
  heartbeatOutcome?: HeartbeatOutcomeRow;
  messageToolOutcomes: Array<MessageToolRunOutcomeInsert & { id: number }>;
  trajectory: Map<string, SessionActorMemoryTrajectoryRow[]>;
};

export function createSessionActorMemorySideEffects(): SessionActorMemorySideEffectsState {
  return { outbox: new Map(), messageToolOutcomes: [], trajectory: new Map() };
}

/** Rows are immutable; commands replace them instead of mutating shared preimages. */
export function cloneSessionActorMemorySideEffects(
  state: SessionActorMemorySideEffectsState,
): SessionActorMemorySideEffectsState {
  return {
    outbox: new Map(state.outbox),
    heartbeatOutcome: state.heartbeatOutcome,
    messageToolOutcomes: [...state.messageToolOutcomes],
    trajectory: new Map(state.trajectory),
  };
}
