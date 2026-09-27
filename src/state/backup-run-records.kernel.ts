import type { DatabaseSync } from "node:sqlite";
import type { Insertable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateDatabase } from "./openclaw-state-db.generated.js";

type BackupRunDatabase = Pick<OpenClawStateDatabase, "backup_runs">;
export type PreparedBackupRunRecord = Insertable<BackupRunDatabase["backup_runs"]>;

/** The caller owns one transaction for both insertion and retention. */
export function recordBackupRunInDatabase(db: DatabaseSync, row: PreparedBackupRunRecord): void {
  const kysely = getNodeSqliteKysely<BackupRunDatabase>(db);
  executeSqliteQuerySync(db, kysely.insertInto("backup_runs").values(row));
  // This is a bounded operational log. Hourly scheduled backups must not grow it forever.
  executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom("backup_runs")
      .where(
        "id",
        "in",
        kysely
          .selectFrom("backup_runs")
          .select("id")
          .orderBy("created_at", "desc")
          .orderBy("id", "desc")
          .limit(2_147_483_647)
          .offset(200),
      ),
  );
}
