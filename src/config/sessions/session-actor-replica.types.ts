import type { sessionChangeAffectsStoredRow } from "../../sessions/session-row-facts.js";
import type { AgentDatabaseExecutionFileIdentity } from "../../state/openclaw-agent-execution-contract.js";
import type { SessionActorHotState, SessionActorTarget } from "./session-actor-state.types.js";
import type { SessionActorTranscriptReplica } from "./session-actor-transcript-replica.js";
import type { SessionEntrySnapshotField } from "./session-entry-snapshot-values.js";
import type { SessionRowDatabaseFacts } from "./session-row-facts.types.js";

export type SessionActorEntryFacts = Pick<
  SessionActorHotState,
  "target" | "entry" | "writeToken" | "dependencySessionIds"
> &
  Partial<Pick<SessionActorHotState, "participants" | "members">> & {
    snapshots: "full" | readonly SessionEntrySnapshotField[];
    /** Only a complete actor transcript snapshot proves archive absence. */
    coldArchiveAbsent?: boolean;
    projection?: Pick<SessionRowDatabaseFacts, "hasBoard" | "activitySummaryWatermark">;
  };

export type FileTarget = SessionActorTarget & { database: AgentDatabaseExecutionFileIdentity };
export type ReplicaCell = {
  target: SessionActorTarget;
  publicationScope: Parameters<typeof sessionChangeAffectsStoredRow>[1];
  snapshot?: SessionActorHotState;
  entry?: SessionActorEntryFacts;
  transcript?: SessionActorTranscriptReplica;
  transcriptBytes: number;
  generation?: string;
  handles: number;
  bytes: number;
};
export type ReplicaPool = {
  cells: Map<string, ReplicaCell>;
  snapshots: number;
  bytes: number;
  unsubscribe?: () => void;
};
