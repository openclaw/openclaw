// Closed consistency labels are safe to retain in worker messages and public reports.
const SQLITE_SNAPSHOT_CHANGE_REASONS = [
  "source-disappeared",
  "source-identity-changed",
  "journal-state-changed",
  "journal-mode-changed",
  "wal-copy-unstable",
  "wal-changed-during-copy",
  "main-changed-during-copy",
  "rollback-journal-changed-during-copy",
  "recovery-data-appeared",
  "retained-snapshot-changed",
] as const;

export type SqliteSnapshotChangeReason = (typeof SQLITE_SNAPSHOT_CHANGE_REASONS)[number];

export const SQLITE_SNAPSHOT_STABILIZATION_DETAILS = new RegExp(
  `\\(reason=(?:${SQLITE_SNAPSHOT_CHANGE_REASONS.join("|")}), attempts=[1-9][0-9]{0,2}\\)`,
  "u",
);
