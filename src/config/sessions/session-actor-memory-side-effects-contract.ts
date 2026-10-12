import type { ContextEngineTurnOutboxWorkerOperations } from "../../agents/harness/context-engine-turn-outbox.js";
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
