import type { DatabaseSync } from "node:sqlite";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { executeSqliteQuerySync, sqliteStringSet } from "../../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import { getCronStoreKysely } from "./schema.js";

/** Shared-state/history workers; native saves are limited to Doctor transaction hooks. */
export function readCronJobNamesInDatabase(
  db: DatabaseSync,
  jobIds: readonly string[] | undefined,
  storePath: string,
) {
  if (getAdmittedSqliteSchemaFacts(db)?.tables.has("cron_jobs") === false) {
    return new Map<string, string | undefined>();
  }
  let query = getCronStoreKysely(db)
    .selectFrom("cron_jobs")
    .select(["job_id", "name"])
    .where("store_key", "=", storePath);
  if (jobIds) {
    query = query.where("job_id", "in", sqliteStringSet(jobIds));
  }
  const rows = executeSqliteQuerySync(db, query).rows;
  return new Map(rows.map((row) => [row.job_id, normalizeOptionalString(row.name)]));
}
