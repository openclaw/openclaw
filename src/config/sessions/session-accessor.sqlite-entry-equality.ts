import type { ResolvedSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { SqliteSessionMutationConflictError } from "./session-mutation-conflict-error.js";
import type { SessionEntry } from "./types.js";

export type SqliteLifecycleTargetSnapshot = Array<{
  entry: SessionEntry;
  sessionKey: string;
  /** Complete rows from preparation; absent snapshots require a hydrated commit read. */
  persistedRows?: {
    lookupKeys: readonly string[];
    rows: readonly ResolvedSessionEntryRow["row"][];
  };
}>;

export function sqliteSessionEntriesEqual(
  left: SessionEntry | undefined,
  right: SessionEntry | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  const {
    participants: _leftParticipants,
    participantCount: _leftParticipantCount,
    sessionDiffBaseline: leftBaseline,
    skillsSnapshot: leftSkills,
    systemPromptReport: leftReport,
    ...leftEntry
  } = left;
  const {
    participants: _rightParticipants,
    participantCount: _rightParticipantCount,
    sessionDiffBaseline: rightBaseline,
    skillsSnapshot: rightSkills,
    systemPromptReport: rightReport,
    ...rightEntry
  } = right;
  // Participant history is a separately mutable SQLite projection. It must not
  // invalidate logical-session compare-and-swap or leak into entry_json writes.
  // Hydration appends cold fields to hot facts; their original top-level order is not identity.
  return (
    JSON.stringify(leftEntry) === JSON.stringify(rightEntry) &&
    JSON.stringify(leftBaseline) === JSON.stringify(rightBaseline) &&
    JSON.stringify(leftSkills) === JSON.stringify(rightSkills) &&
    JSON.stringify(leftReport) === JSON.stringify(rightReport)
  );
}

export function sqliteLifecycleTargetSnapshotsEqual(
  left: SqliteLifecycleTargetSnapshot,
  right: SqliteLifecycleTargetSnapshot,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (row, index) =>
        row.sessionKey === right[index]?.sessionKey &&
        sqliteSessionEntriesEqual(row.entry, right[index]?.entry),
    )
  );
}

export function assertLifecycleTargetSnapshotUnchanged(
  expected: SqliteLifecycleTargetSnapshot,
  current: SqliteLifecycleTargetSnapshot,
  operationLabel: string,
): void {
  if (!sqliteLifecycleTargetSnapshotsEqual(expected, current)) {
    throw new SqliteSessionMutationConflictError(operationLabel);
  }
}
