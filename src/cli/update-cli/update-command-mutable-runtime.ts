import { disableCurrentOpenClawUpdateLaunchdJob } from "../../daemon/launchd.js";
import { cleanupStaleManagedServiceUpdateHandoffs } from "../../infra/update-managed-service-handoff-cleanup.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../../state/openclaw-state-ownership.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";

/** Prepare mutable runtime state only under the admitted installation owner. */
export async function prepareMutableUpdateRuntime(
  env: NodeJS.ProcessEnv | undefined,
  fence: UpdateRecoveryFence,
) {
  return await withOwnedManagedUpdateEnv(env, async () => {
    fence.assertCurrent();
    await cleanupStaleManagedServiceUpdateHandoffs().catch(() => undefined);
    fence.assertCurrent();
    await assertOpenClawStateWriteAllowedAtPath({
      databasePath: resolveOpenClawStateSqlitePath(process.env),
    });
    fence.assertCurrent();
    await disableCurrentOpenClawUpdateLaunchdJob().catch(() => undefined);
    fence.assertCurrent();
    const records = await loadInstalledPluginIndexInstallRecords();
    fence.assertCurrent();
    return records;
  });
}
