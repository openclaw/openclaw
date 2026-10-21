import { withMaintenanceOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly-reuse.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import type { EngineConnection } from "./sql-connection.js";
import { prepareSqliteReadOnlyLocation } from "./sqlite-snapshot-source.js";
import { runSqliteReadSnapshotSync } from "./sqlite-transaction.js";

/** Inspect synchronously; the maintenance owner or this helper owns connection cleanup. */
export async function withSqliteReadOnlyInspection<T>(
  pathname: string,
  inspect: (db: EngineConnection) => T,
): Promise<T> {
  const reused = withMaintenanceOpenClawStateDatabaseReadOnly(
    ({ db }) => runSqliteReadSnapshotSync(db, () => inspect(db)),
    pathname,
  );
  if (reused.reused) {
    return reused.value;
  }
  const snapshot = await prepareSqliteReadOnlyLocation(pathname, {
    preserveSourceArtifacts: true,
  });
  try {
    const db = openNodeSqliteDatabase(snapshot.location, { readOnly: true });
    try {
      return runSqliteReadSnapshotSync(db, () => inspect(db));
    } finally {
      db.close();
    }
  } finally {
    await snapshot.cleanupAsync();
  }
}
