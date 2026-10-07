import path from "node:path";
import { createSqliteLifecycleAggregateError } from "./sqlite-lifecycle-errors.js";
import {
  retainSnapshotTempDirectory,
  SqliteSnapshotCleanupError,
} from "./sqlite-readonly-location-cleanup.js";
import type {
  SqliteAuthProfileReadOptions,
  SqliteAuthProfileRows,
} from "./sqlite-readonly-worker-protocol.js";
import { prepareSqliteReadOnlyLocation } from "./sqlite-snapshot-source.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "./sqlite-worker-identity.js";

/** The admitted worker operation owns these private bytes through native read settlement. */
export async function readArtifactPreservingAuthRows(
  pathname: string,
  options: SqliteAuthProfileReadOptions,
  read: (location: string, options: SqliteAuthProfileReadOptions) => Promise<SqliteAuthProfileRows>,
): Promise<SqliteAuthProfileRows> {
  assertExistingDatabaseIdentity(pathname, options.expectedIdentity);
  const snapshot = await prepareSqliteReadOnlyLocation(pathname, {
    preserveSourceArtifacts: true,
    signal: options.signal,
  });
  const release = retainSnapshotTempDirectory(
    snapshot.cleanupRoot ?? path.dirname(snapshot.location),
  );
  let outcome: { ok: true; value: SqliteAuthProfileRows } | { ok: false; error: unknown };
  try {
    assertExistingDatabaseIdentity(pathname, options.expectedIdentity);
    const rows = await read(snapshot.location, {
      ...options,
      source: "snapshot",
      expectedIdentity: readDatabasePathIdentitySync(snapshot.location).key,
    });
    assertExistingDatabaseIdentity(pathname, options.expectedIdentity);
    outcome = { ok: true, value: { ...rows, cacheable: false } };
  } catch (error) {
    outcome = { ok: false, error };
  }
  try {
    release();
    if (!(await snapshot.cleanupAsync())) {
      throw new SqliteSnapshotCleanupError("SQLite inspection snapshot cleanup failed.");
    }
  } catch (error) {
    throw outcome.ok
      ? error
      : createSqliteLifecycleAggregateError(
          [outcome.error, error],
          "SQLite inspection and snapshot cleanup failed.",
          outcome.error,
        );
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}
