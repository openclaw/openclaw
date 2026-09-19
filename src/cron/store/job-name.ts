import { toUSVString } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { executeSqliteQuerySync, sqliteStringSet } from "../../infra/kysely-sync.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { resolveCronJobsStorePath } from "./paths.js";
import { getCronStoreKysely } from "./schema.js";

/** Read display metadata without loading payloads or running cron store repairs. */
export function createCronJobNameResolver(
  jobIds: readonly string[],
): (jobId: string) => string | undefined {
  let names: Map<string, string | undefined> | undefined;
  return (jobId) => {
    if (!names) {
      const storePath = resolveCronJobsStorePath();
      names =
        withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
          if (!tableExists(db, "cron_jobs")) {
            return new Map<string, string | undefined>();
          }
          const rows = executeSqliteQuerySync(
            db,
            getCronStoreKysely(db)
              .selectFrom("cron_jobs")
              .select(["job_id", "name"])
              .where("store_key", "=", storePath)
              .where("job_id", "in", sqliteStringSet(jobIds)),
          ).rows;
          return new Map(rows.map((row) => [row.job_id, normalizeOptionalString(row.name)]));
        }) ?? new Map<string, string | undefined>();
    }
    // Match native string binding, including a lone surrogate in stored provenance.
    return names.get(toUSVString(jobId));
  };
}
