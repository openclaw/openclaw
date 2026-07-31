import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { incrementCronStoreEpoch } from "./row-codec.js";
import { getCronStoreKysely } from "./schema.js";

export type CronJobFamilyIdentity = {
  declarationKey: string;
  name: string;
  ownerPluginTag: string;
};

/** Removes one owned job family from obsolete store partitions. */
export function deleteStaleCronJobFamilyRows(
  db: DatabaseSync,
  activeStoreKey: string,
  family: CronJobFamilyIdentity,
): number {
  const staleRows = executeSqliteQuerySync(
    db,
    getCronStoreKysely(db)
      .selectFrom("cron_jobs")
      .select(["store_key", "job_id", "declaration_key", "name", "description"])
      .where("store_key", "!=", activeStoreKey),
  ).rows.filter(
    (row) =>
      row.declaration_key === family.declarationKey ||
      (row.name === family.name && row.description?.includes(family.ownerPluginTag) === true),
  );
  const affectedStoreKeys = new Set(staleRows.map((row) => row.store_key));
  for (const row of staleRows) {
    executeSqliteQuerySync(
      db,
      getCronStoreKysely(db)
        .deleteFrom("cron_job_scratch")
        .where("store_key", "=", row.store_key)
        .where("job_id", "=", row.job_id),
    );
    executeSqliteQuerySync(
      db,
      getCronStoreKysely(db)
        .deleteFrom("cron_jobs")
        .where("store_key", "=", row.store_key)
        .where("job_id", "=", row.job_id),
    );
  }
  // The caller owns the shared-state transaction. Advance every affected
  // partition there too, so a live stale writer cannot resurrect pruned jobs.
  for (const storeKey of affectedStoreKeys) {
    incrementCronStoreEpoch(db, storeKey);
  }
  return staleRows.length;
}
