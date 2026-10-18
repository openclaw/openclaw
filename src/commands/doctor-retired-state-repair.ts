import { resolveStateDir } from "../config/paths.js";
import { withLegacyMigrationStateLock } from "../infra/state-migrations.lock.js";
import { archiveRetiredStateFiles } from "../infra/state-migrations.retired-archive.js";
import { listRetiredDeliveryQueueFiles } from "../infra/state-migrations.retired-delivery-files.js";
import { listExistingRetiredStateFiles } from "../infra/state-migrations.retired-files.js";
import { listRetiredRuntimeStateFiles } from "../infra/state-migrations.retired-runtime-files.js";
import { migrateRetiredRuntimeState } from "../infra/state-migrations.retired-runtime.js";
import type { MigrationMessages } from "../infra/state-migrations.types.js";
import { resolveLegacyInstalledPluginIndexStorePath } from "../plugins/installed-plugin-index-store-path.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";

/** Run before plugin discovery and config recovery can hide the original locators. */
export async function repairRetiredDoctorState(
  env: NodeJS.ProcessEnv = process.env,
): Promise<MigrationMessages> {
  const stateDir = resolveStateDir(env);
  const queueFiles = listRetiredDeliveryQueueFiles(stateDir);
  const indexPath = resolveLegacyInstalledPluginIndexStorePath({ stateDir });
  if (
    listExistingRetiredStateFiles([
      ...listRetiredRuntimeStateFiles(stateDir, env),
      ...queueFiles,
      indexPath,
    ]).length === 0
  ) {
    return { changes: [], warnings: [] };
  }
  return withLegacyMigrationStateLock({
    stateDir,
    env,
    label: "retired state",
    releaseLabel: "Retired state",
    run: async (stateEnv) => {
      const maintenance = getOpenClawDatabaseMaintenanceScope();
      if (!maintenance) {
        throw new Error("Retired state repair requires exclusive maintenance ownership");
      }
      const assertCurrent = maintenance.assertOwnerCurrent;
      const result = await migrateRetiredRuntimeState({ stateDir, env: stateEnv, assertCurrent });
      for (const archive of [
        {
          label: "delivery queue",
          paths: queueFiles,
          recoveryInstructions:
            "Legacy deliveries are not replayed automatically because they may already have been sent. Inspect the archived payload and explicitly resend any still-needed message through its channel; do not restore it to the queue.",
        },
        {
          label: "plugin install index",
          paths: [indexPath],
          recoveryInstructions:
            "Doctor rebuilds the plugin inventory from configured installs. If a plugin is missing, inspect this archive for its package spec and run openclaw plugins install <package-spec>.",
        },
      ]) {
        const archived = await archiveRetiredStateFiles({ ...archive, assertCurrent });
        result.changes.push(...archived.changes);
        result.warnings.push(...archived.warnings);
      }
      return { ...result, warningDisposition: "recoverable" };
    },
  });
}
