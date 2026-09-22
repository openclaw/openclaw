import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { resolveCronJobsStorePath } from "./paths.js";
import { getCronStoreKysely } from "./schema.js";

/** Read display metadata without loading payloads or running cron store repairs. */
export function createCronJobNameResolver(): (jobId: string) => string | undefined {
  let storePath: string | undefined;
  return (jobId) => {
    const activeStorePath = (storePath ??= resolveCronJobsStorePath());
    return withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
      if (!tableExists(db, "cron_jobs")) {
        return undefined;
      }
      const row = executeSqliteQuerySync(
        db,
        getCronStoreKysely(db)
          .selectFrom("cron_jobs")
          .select("name")
          .where("store_key", "=", activeStorePath)
          .where("job_id", "=", jobId),
      ).rows[0];
      return normalizeOptionalString(row?.name);
    });
  };
}
