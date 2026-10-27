import type { InternalSessionEntry as SessionEntry, PersistedSessionRunStatus } from "./types.js";

/** `null` requires a revision-less row; omitting the field skips the revision fence. */
export type SessionLifecycleRevisionExpectation = string | null;

/** Authoritative lifecycle snapshot required for an atomic transcript admission. */
export type SessionTranscriptTurnExpectedState = {
  /** When supplied, fences a goal mutation committed with the transcript. */
  goal?: SessionEntry["goal"];
  /** When supplied, fences exact pending-final custody; null requires its absence. */
  pendingFinalDelivery?: SessionEntry["pendingFinalDelivery"] | null;
  /** Rejects a run-owned turn after another admitted run takes writer ownership. */
  expectedWriterRunId?: string;
  abortedLastRun: boolean | undefined;
  status: PersistedSessionRunStatus | undefined;
};

/** Lifecycle fields committed with an accepted transcript turn. */
export type SessionTranscriptTurnLifecyclePatch = {
  goal?: SessionEntry["goal"];
  abortedLastRun?: boolean;
  endedAt?: number;
  lifecycleRunId?: SessionEntry["lifecycleRunId"];
  lastRunId?: SessionEntry["lastRunId"];
  lastRunError?: SessionEntry["lastRunError"];
  lastInteractionAt?: number;
  pendingFinalDelivery?: SessionEntry["pendingFinalDelivery"];
  runtimeMs?: number;
  startedAt?: number;
  status?: PersistedSessionRunStatus;
  updatedAt?: number;
};
