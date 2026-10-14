import type { DatabaseSync } from "node:sqlite";
import type { Insertable } from "kysely";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import {
  BACKUP_RUN_WINDOW,
  parseBackupRun,
  resolveBackupRunNamespace,
  resolveBackupRunTarget,
  type BackupRunRecord,
} from "./backup-run-records.contract.js";
import type { DB as OpenClawStateDatabase } from "./openclaw-state-db.generated.js";

type BackupRunDatabase = Pick<OpenClawStateDatabase, "backup_runs">;
export type PreparedBackupRunRecord = Insertable<BackupRunDatabase["backup_runs"]>;

/** The caller owns one transaction for both insertion and retention. */
export function recordBackupRunInDatabase(db: DatabaseSync, row: PreparedBackupRunRecord): void {
  const kysely = getNodeSqliteKysely<BackupRunDatabase>(db);
  executeSqliteQuerySync(db, kysely.insertInto("backup_runs").values(row));
  const runs = readBackupRunsInDatabase(db);
  const retainedIds = new Set(runs.slice(0, BACKUP_RUN_WINDOW).map((run) => run.id));
  const latestTargets = new Set<string>();
  const latestOkTargets = new Set<string>();
  // Frequent jobs must not evict another target's last attempt or successful recovery point.
  for (const run of runs) {
    const target = JSON.stringify([
      run.kind,
      run.location?.name ?? resolveBackupRunTarget(run),
      resolveBackupRunNamespace(run),
    ]);
    if (!latestTargets.has(target)) {
      latestTargets.add(target);
      retainedIds.add(run.id);
    }
    if (run.status === "ok" && !latestOkTargets.has(target)) {
      latestOkTargets.add(target);
      retainedIds.add(run.id);
    }
  }
  executeSqliteQuerySync(
    db,
    kysely.deleteFrom("backup_runs").where("id", "not in", sqliteStringSet([...retainedIds])),
  );
}

/** Reads only the bounded ledger, using facts captured by database admission. */
export function readBackupRunsInDatabase(db: DatabaseSync): BackupRunRecord[] {
  if (!getAdmittedSqliteSchemaFacts(db)?.tables.has("backup_runs")) {
    return [];
  }
  return executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<BackupRunDatabase>(db)
      .selectFrom("backup_runs")
      .selectAll()
      .orderBy("created_at", "desc")
      .orderBy("id", "desc"),
  ).rows.flatMap((row) => {
    const record = parseBackupRun(row);
    return record ? [record] : [];
  });
}
