import { disableCurrentOpenClawUpdateLaunchdJob } from "../../daemon/launchd.js";
import { assertUpdateInitialStoreInvocation } from "../../infra/update-initial-store-invocation.js";
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
    assertUpdateInitialStoreInvocation();
    fence.assertCurrent();
    await cleanupStaleManagedServiceUpdateHandoffs().catch(() => undefined);
    assertUpdateInitialStoreInvocation();
    fence.assertCurrent();
    await assertOpenClawStateWriteAllowedAtPath({
      databasePath: resolveOpenClawStateSqlitePath(process.env),
    });
    assertUpdateInitialStoreInvocation();
    fence.assertCurrent();
    await disableCurrentOpenClawUpdateLaunchdJob().catch(() => undefined);
    assertUpdateInitialStoreInvocation();
    fence.assertCurrent();
    const records = await loadInstalledPluginIndexInstallRecords();
    assertUpdateInitialStoreInvocation();
    fence.assertCurrent();
    return records;
  });
}
