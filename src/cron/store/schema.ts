/** Kysely row types and table facade for the cron_jobs SQLite table. */
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import { getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";

type CronJobsTable = OpenClawStateKyselyDatabase["cron_jobs"];
type CronStoreDatabase = Pick<OpenClawStateKyselyDatabase, "cron_job_scratch" | "cron_jobs">;

// Keep native integer conversion in the table's column order.
export const CRON_JOB_READ_COLUMNS = [
  "job_id",
  "declaration_key",
  "enabled",
  "agent_id",
  "payload_kind",
  "job_json",
  "state_json",
  "runtime_updated_at_ms",
  "schedule_identity",
  "sort_order",
  "updated_at",
] as const;

/** Complete stored row used by independent cron inventories. */
export type CronJobRow = Selectable<CronJobsTable>;

/** Read shape consumed by cron decoding, conflict checks, and owner migration. */
export type CronJobReadRow = Pick<CronJobRow, (typeof CRON_JOB_READ_COLUMNS)[number]>;

/** Insert/update shape for rows in the cron_jobs SQLite table. */
export type CronJobInsert = Insertable<CronJobsTable>;

/** Creates the Kysely facade scoped to cron_jobs for synchronous SQLite access. */
export function getCronStoreKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<CronStoreDatabase>(db);
}
