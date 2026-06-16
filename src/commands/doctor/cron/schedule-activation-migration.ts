// Doctor-owned backfill for the canonical cron schedule activation boundary.
import path from "node:path";
import { cronStoreKey } from "../../../cron/store/key.js";
import { getCronStoreKysely } from "../../../cron/store/schema.js";
import { stateFromRow } from "../../../cron/store/state-codec.js";
import { executeSqliteQuerySync } from "../../../infra/kysely-sync.js";
import { runOpenClawStateWriteTransaction } from "../../../state/openclaw-state-db.js";

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Re-activate cron jobs created before scheduleActivatedAtMs existed.
 *
 * Legacy rows have no trustworthy schedule-only timestamp. The migration time
 * is therefore the first canonical replay boundary: pre-upgrade inferred slots
 * are dropped, while future missed slots remain replayable.
 */
export function migrateCronScheduleActivationTimestamps(
  storePath: string,
  nowMs = Date.now(),
): number {
  if (!isFiniteTimestamp(nowMs)) {
    throw new Error("Cron schedule activation migration requires a valid timestamp");
  }
  const storeKey = cronStoreKey(path.resolve(storePath));
  return runOpenClawStateWriteTransaction(({ db }) => {
    const cronStore = getCronStoreKysely(db);
    const rows = executeSqliteQuerySync(
      db,
      cronStore
        .selectFrom("cron_jobs")
        .selectAll()
        .where("store_key", "=", storeKey)
        .where("schedule_kind", "=", "cron"),
    ).rows;
    let migrated = 0;

    for (const row of rows) {
      const state = stateFromRow(row);
      if (isFiniteTimestamp(state.scheduleActivatedAtMs)) {
        continue;
      }
      state.scheduleActivatedAtMs = nowMs;
      executeSqliteQuerySync(
        db,
        cronStore
          .updateTable("cron_jobs")
          .set({ state_json: JSON.stringify(state) })
          .where("store_key", "=", storeKey)
          .where("job_id", "=", row.job_id),
      );
      migrated += 1;
    }

    return migrated;
  });
}
