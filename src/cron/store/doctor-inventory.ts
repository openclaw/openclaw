import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { PluginDoctorCronJob } from "../../plugins/doctor-contract-module.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { getInvalidPersistedCronJobReason } from "../persisted-shape.js";
import { tryParseJsonObject } from "./scalar-codec.js";
import { getCronStoreKysely } from "./schema.js";

/** Raw inspection deliberately bypasses runtime loading and its repair/filter policies. */
export function inspectCronRowsForDoctor(db: DatabaseSync): PluginDoctorCronJob[] {
  if (!tableExists(db, "cron_jobs")) {
    return [];
  }
  return executeSqliteQuerySync(
    db,
    getCronStoreKysely(db)
      .selectFrom("cron_jobs")
      .select(["store_key", "job_id", "declaration_key", "job_json", "state_json", "sort_order"])
      .orderBy("store_key")
      .orderBy("sort_order")
      .orderBy("job_id"),
  ).rows.map((row) => {
    const definition = tryParseJsonObject(row.job_json) ?? null;
    const state = tryParseJsonObject(row.state_json);
    const invalidReason = !definition
      ? "invalid-definition-json"
      : definition.id !== row.job_id
        ? "job-id-mismatch"
        : (definition.declarationKey ?? null) !== row.declaration_key
          ? "declaration-key-mismatch"
          : !state
            ? "invalid-state-json"
            : getInvalidPersistedCronJobReason({ ...definition, state });
    const inspected: PluginDoctorCronJob = {
      storeKey: row.store_key,
      id: row.job_id,
      sortOrder: row.sort_order,
      definitionJson: row.job_json,
      definition,
    };
    if (invalidReason) {
      inspected.invalidReason = invalidReason;
    }
    return inspected;
  });
}
