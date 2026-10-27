import type { ResolvedSessionEntryRow } from "./session-entry-storage.types.js";
import type { SessionEntryWindowFacts } from "./session-entry-window.types.js";
import { SqliteSessionMutationConflictError } from "./session-mutation-conflict-error.js";
import type { InternalSessionEntry, SessionEntry } from "./types.js";

export type SqliteLifecycleTargetSnapshot = Array<{
  entry: InternalSessionEntry;
  sessionKey: string;
  window?: SessionEntryWindowFacts;
  sideTables?: { memberIdsJson: string; hasBoard: boolean };
  row?: ResolvedSessionEntryRow["row"];
}>;

export function sqliteSessionEntriesEqual(
  left: SessionEntry | undefined,
  right: SessionEntry | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  // Participant history is a separately mutable projection. All other fields
  // retain JSON omission semantics, but replica deltas may change top-level order.
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (key === "participants" || key === "participantCount") {
      continue;
    }
    if (JSON.stringify(Reflect.get(left, key)) !== JSON.stringify(Reflect.get(right, key))) {
      return false;
    }
  }
  return true;
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
