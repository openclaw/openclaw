import type { AgentDatabaseExecutionFileIdentity } from "../../state/openclaw-agent-execution-contract.js";
import type { SessionActorHotState, SessionActorTarget } from "./session-actor-state.types.js";
import type { SessionActorTranscriptReplica } from "./session-actor-transcript-replica.js";
import type { SessionEntrySnapshotField } from "./session-entry-snapshot-values.js";
import type { deriveSessionPredicateColumns } from "./session-predicate-columns.js";
import type { SessionRowDatabaseFacts } from "./session-row-facts.types.js";

export type SessionActorEntryFacts = Pick<
  SessionActorHotState,
  "target" | "entry" | "writeToken" | "dependencySessionIds"
> &
  Partial<Pick<SessionActorHotState, "participants" | "members">> & {
    snapshots: "full" | readonly SessionEntrySnapshotField[];
    projection?: Pick<SessionRowDatabaseFacts, "hasBoard" | "activitySummaryWatermark">;
    predicateColumns?: ReturnType<typeof deriveSessionPredicateColumns>;
  };

export type FileTarget = SessionActorTarget & { database: AgentDatabaseExecutionFileIdentity };
export type ReplicaCell = {
  target: SessionActorTarget;
  snapshot?: SessionActorHotState;
  entry?: SessionActorEntryFacts;
  transcript?: SessionActorTranscriptReplica;
  predicateColumns?: SessionActorEntryFacts["predicateColumns"];
  generation?: string;
  reservation: number;
  handles: number;
  pending: number;
  bytes: number;
};
export type ReplicaPool = {
  cells: Map<string, ReplicaCell>;
  snapshots: number;
  bytes: number;
  unsubscribe?: () => void;
};
