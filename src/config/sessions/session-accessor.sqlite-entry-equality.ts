import { isDeepStrictEqual } from "node:util";
import type { ResolvedSessionEntryRow } from "./session-entry-storage.types.js";
import type { SessionEntryWindowFacts } from "./session-entry-window.types.js";
import { SqliteSessionMutationConflictError } from "./session-mutation-conflict-error.js";
import type { SessionEntry } from "./types.js";

export type SqliteLifecycleTargetSnapshot = Array<{
  entry: SessionEntry;
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
  // retain JSON omission semantics; replica deltas may reorder nested keys too.
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (key === "participants" || key === "participantCount") {
      continue;
    }
    const leftValue = Reflect.get(left, key);
    const rightValue = Reflect.get(right, key);
    if (leftValue === rightValue) {
      continue;
    }
    const leftJson = JSON.stringify(leftValue);
    const rightJson = JSON.stringify(rightValue);
    if (
      leftJson !== rightJson &&
      (leftJson === undefined ||
        rightJson === undefined ||
        !isDeepStrictEqual(JSON.parse(leftJson), JSON.parse(rightJson)))
    ) {
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
