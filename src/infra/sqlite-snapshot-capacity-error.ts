const SQLITE_SNAPSHOT_CAPACITY_ERROR_NAME = "SqliteSnapshotCapacityError";

export class SqliteSnapshotCapacityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = SQLITE_SNAPSHOT_CAPACITY_ERROR_NAME;
  }
}

export function hasSqliteSnapshotCapacityCode(error: Error): boolean {
  const { code, errcode }: NodeJS.ErrnoException & { errcode?: unknown } = error;
  return code === "ENOSPC" || code === "EDQUOT" || errcode === 13;
}

/** Ordinary staging-worker error hydration preserves the owner's name, not its prototype. */
export function isSqliteSnapshotCapacityError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    !(error instanceof AggregateError) &&
    error.name === SQLITE_SNAPSHOT_CAPACITY_ERROR_NAME
  );
}
