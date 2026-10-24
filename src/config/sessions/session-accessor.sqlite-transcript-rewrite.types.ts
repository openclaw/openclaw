import type { SqliteTranscriptSnapshotRow } from "./session-accessor.sqlite-read.js";

export type TranscriptReplacementOptions = {
  createdAtByIndex?: readonly number[];
  /** Keep maintenance rewrites at their existing recency while invalidating stale projections. */
  preserveSessionWindowRecency?: boolean;
  scheduleProjectionReconcile?: boolean;
  onProjectionReconcileNeeded?: () => void;
  /** Capture inserted bytes only when the caller retains a replacement snapshot. */
  writtenRows?: SqliteTranscriptSnapshotRow[];
};

export type TranscriptRewriteOptions = {
  legacyTextStorage?: boolean;
  projectionCurrent?: boolean;
  touchMutation?: boolean;
};
