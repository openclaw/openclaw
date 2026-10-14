/** Applies a Doctor repair to persisted cron runtime state without replacing it. */
import type { DatabaseSync } from "node:sqlite";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { getCronStoreKysely } from "./schema.js";

/**
 * Re-applies `repair` to each named row's stored state inside the caller's
 * write transaction, persisting only the keys the repair itself changes.
 *
 * Doctor saves repaired definitions with `preserveRuntimeState`, which keeps
 * the definition write from replacing runtime state the scheduler owns, so an
 * existing row's `state_json` is excluded from the upsert's conflict update and
 * a normalization that only repaired runtime fields is discarded on reload.
 * Writing the normalized store's state back wholesale would persist the repair
 * but reintroduce exactly the clobber `preserveRuntimeState` prevents: Doctor's
 * snapshot guard fingerprints definitions only (`fingerprintCronJobRows`), so
 * it cannot see a run outcome the scheduler wrote while Doctor was waiting.
 *
 * Re-running the repair against the row's live state inside the transaction
 * avoids both. The repair observes current state rather than Doctor's earlier
 * read, it reports whether anything still needed changing, and a row the
 * scheduler has since moved past the legacy shape is left untouched — which
 * also makes a second `openclaw doctor --fix` a no-op.
 *
 * Returns the job ids whose stored state was rewritten.
 */
export function applyCronJobRuntimeStateRepairs(
  db: DatabaseSync,
  storeKey: string,
  jobIds: readonly string[],
  repair: (state: Record<string, unknown>) => boolean,
): string[] {
  const repaired: string[] = [];
  for (const jobId of jobIds) {
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getCronStoreKysely(db)
        .selectFrom("cron_jobs")
        .select("state_json")
        .where("store_key", "=", storeKey)
        .where("job_id", "=", jobId),
    );
    const state = row ? safeParseJsonRecord(row.state_json) : undefined;
    if (!state || !repair(state)) {
      continue;
    }
    executeSqliteQuerySync(
      db,
      getCronStoreKysely(db)
        .updateTable("cron_jobs")
        .set({ state_json: JSON.stringify(state) })
        .where("store_key", "=", storeKey)
        .where("job_id", "=", jobId),
    );
    repaired.push(jobId);
  }
  return repaired;
}
