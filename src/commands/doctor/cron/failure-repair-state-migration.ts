import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getCronStoreKysely } from "../../../cron/store/schema.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { executeSqliteQuerySync } from "../../../infra/kysely-sync.js";
import { getOpenClawDatabaseMaintenanceScope } from "../../../state/openclaw-state-db-async-lifecycle.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../../state/openclaw-state-db-readonly.js";
import { tableExists } from "../../../state/openclaw-state-db-schema-helpers.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { repairCronJobStatesForDoctor } from "./store-repair.js";

/**
 * OpenClaw 2026.10.x recorded an owner-conversation repair inside the alert incident as
 * `failureAlertIncident.repair: { atMs, deadlineAtMs?, settledAtMs?, alerted? }`. Moves it to
 * the canonical `failureRepair` state so the streak is not repaired twice. Returns whether the
 * state changed.
 */
export function migrateLegacyCronFailureRepairState(state: Record<string, unknown>): boolean {
  const incident = state.failureAlertIncident;
  if (!isRecord(incident) || !Object.hasOwn(incident, "repair")) {
    return false;
  }
  const { repair } = incident;
  delete incident.repair;
  if (isRecord(repair) && typeof repair.atMs === "number" && state.failureRepair === undefined) {
    const { atMs, deadlineAtMs, settledAtMs } = repair;
    state.failureRepair = {
      startedAtMs: atMs,
      // Before deadlines existed, the request itself was the verification boundary.
      deadlineAtMs: typeof deadlineAtMs === "number" ? deadlineAtMs : atMs,
      ...(typeof settledAtMs === "number" ? { settledAtMs } : {}),
      // The fallback alert of that streak was its escalation.
      ...(repair.alerted === true ? { escalatedAtMs: atMs } : {}),
    };
  }
  return true;
}

export async function maybeRepairLegacyCronFailureRepairState(params: {
  shouldRepair: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const env = params.env ?? process.env;
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  // Runtime ignores the retired marker, so only an offline repair needs to inspect it.
  if (!params.shouldRepair || !maintenance?.ownsSchemaMaintenance) {
    return { changes: [], warnings: [] };
  }
  const databasePath = resolveOpenClawStateSqlitePath(env);
  try {
    const rows =
      withExistingOpenClawStateDatabaseReadOnly(
        ({ db }) =>
          tableExists(db, "cron_jobs")
            ? executeSqliteQuerySync(
                db,
                getCronStoreKysely(db)
                  .selectFrom("cron_jobs")
                  .select(["store_key", "job_id", "state_json"])
                  .orderBy("store_key")
                  .orderBy("job_id"),
              ).rows
            : [],
        { env },
      ) ?? [];
    const changes = rows.flatMap((row) => {
      const state = safeParseJsonRecord(row.state_json);
      return state && migrateLegacyCronFailureRepairState(state)
        ? [
            {
              storeKey: row.store_key,
              jobId: row.job_id,
              from: row.state_json,
              to: JSON.stringify(state),
            },
          ]
        : [];
    });
    if (changes.length === 0) {
      return { changes: [], warnings: [] };
    }
    const assertCurrent = () => maintenance.assertDatabaseAccess(databasePath);
    const result = await repairCronJobStatesForDoctor(
      { env },
      { assertCurrent, assertOwnedInTransaction: assertCurrent },
      changes,
    );
    return {
      changes: [
        `Moved the automatic-repair record of ${result.changed} automation(s) to its current format.`,
        `Saved pre-repair cron backup: ${result.backupPath}`,
      ],
      warnings: result.warnings ?? [],
    };
  } catch (error) {
    return {
      changes: [],
      warnings: [
        `Cron automatic-repair record migration was not committed: ${formatErrorMessage(error)}`,
      ],
    };
  }
}
