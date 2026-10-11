import { formatErrorMessage } from "../../../infra/errors.js";
import type { PluginDoctorCronChange } from "../../../plugins/doctor-contract-module.js";
import { getOpenClawDatabaseMaintenanceScope } from "../../../state/openclaw-state-db-async-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { inspectCronJobsForDoctor, repairCronJobsForDoctor } from "../cron/store-repair.js";
import { rewriteModelRefs } from "./legacy-config-migrations.runtime.models.refs.js";
import { rewriteProviderModelRef } from "./provider-rename.js";
import type { ProviderRename } from "./provider-rename.js";

/** Repair persisted definitions across every cron partition, not just the configured store. */
export async function maybeRepairProviderRenameCronJobs(params: {
  renames: readonly ProviderRename[];
  env?: NodeJS.ProcessEnv;
  shouldRepair: boolean;
}): Promise<{ changes: string[]; warnings: string[] }> {
  if (params.renames.length === 0) {
    return { changes: [], warnings: [] };
  }
  const env = params.env ?? process.env;
  try {
    const inventory = await inspectCronJobsForDoctor({ env });
    const renames = params.renames;
    const requested: PluginDoctorCronChange[] = [];
    const referenceChanges: string[] = [];
    for (const job of inventory.jobs) {
      if (!job.definition) {
        continue;
      }
      const payload = rewriteModelRefs(
        job.definition.payload,
        `cron.${JSON.stringify([job.storeKey, job.id])}.payload`,
        referenceChanges,
        (ref) => rewriteProviderModelRef(ref, renames) ?? null,
      );
      if (payload.changed) {
        requested.push({ job, definition: { ...job.definition, payload: payload.value } });
      }
    }
    if (requested.length === 0) {
      return { changes: [], warnings: [] };
    }
    if (!params.shouldRepair) {
      return {
        changes: [],
        warnings: [
          `Provider renames affect ${requested.length} persisted cron job(s). Run "openclaw doctor --fix" to repair their model references.`,
          ...referenceChanges.map((change) => change.replace(/^Upgraded /, "Would upgrade ")),
        ],
      };
    }
    const maintenance = getOpenClawDatabaseMaintenanceScope();
    if (!maintenance?.ownsSchemaMaintenance) {
      throw new Error(
        'Cron provider rename requires Doctor maintenance. Run "openclaw doctor --fix".',
      );
    }
    const assertCurrent = () => {
      maintenance.assertDatabaseAccess(resolveOpenClawStateSqlitePath(env));
    };
    const result = await repairCronJobsForDoctor(
      { env },
      { assertCurrent, assertOwnedInTransaction: assertCurrent },
      inventory,
      requested,
    );
    return {
      changes:
        result.changed > 0
          ? [
              `Renamed provider model references in ${result.changed} persisted cron job(s).`,
              ...referenceChanges,
              `Saved pre-repair cron backup: ${result.backupPath}`,
            ]
          : [],
      warnings: [],
    };
  } catch (error) {
    return {
      changes: [],
      warnings: [`Failed repairing cron provider model references: ${formatErrorMessage(error)}`],
    };
  }
}
