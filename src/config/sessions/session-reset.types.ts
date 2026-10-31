import type {
  ResetSessionEntryLifecycleMutation,
  SessionLifecycleStoreTarget,
  SessionResetBoundaryWrite,
} from "./session-accessor.lifecycle-types.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import type { SqliteLifecycleTargetSnapshot } from "./session-accessor.sqlite-entry-equality.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** The reset builder runs once on the host; the full selected target is compared in the worker. */
export type SessionResetCommit = {
  agentId: string;
  target: SessionLifecycleStoreTarget;
  prepared: SqliteLifecycleTargetSnapshot;
  nextEntry: SessionEntry;
  resetBoundary?: SessionResetBoundaryWrite;
};

export type SessionResetCommitted = {
  kind: "session-reset";
  mutation: ResetSessionEntryLifecycleMutation;
  previousSessionKeys: string[];
  progressCardReset: boolean;
  projectionNeedsReconcile: boolean;
  publication: SessionEntryReplacementPublication;
};

/** Bundled reply projection data; hooks and live commit authority stay with the host. */
export type ReplySessionInitializationUpsertDescriptor = {
  kind: "reply-initialization";
  expectedRevision: string;
  entry: SessionEntry;
  snapshotEntry?: SessionEntry;
  retiredEntry?: { key: string; entry: SessionEntry };
};
