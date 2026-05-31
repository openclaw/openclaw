import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import { getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";

type CronJobsTable = OpenClawStateKyselyDatabase["cron_jobs"];
type CronStoreDatabase = Pick<OpenClawStateKyselyDatabase, "cron_jobs">;

export type CronJobRow = Selectable<CronJobsTable>;
export type CronJobInsert = Insertable<CronJobsTable>;

export function getCronStoreKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<CronStoreDatabase>(db);
}
