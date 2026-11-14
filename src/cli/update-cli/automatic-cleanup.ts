import { cleanupCompletedUpdateRecovery } from "../../commands/update-automatic-cleanup.js";
import {
  automaticRecoveryCleanupWarning,
  recordAutomaticRecoveryCleanup,
} from "../../infra/update-automatic-cleanup-result.js";
import { isNeverActivatedFailedUpdate } from "../../infra/update-run-activation.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import { runWithLocalStateOwner } from "../local-state-owner.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";

/** A durably failed run that never activated retires its own original-state capture. */
export function failedBeforeActivation(runId: string, env: NodeJS.ProcessEnv): boolean {
  try {
    const record = getUpdateRun(runId, { env });
    return record !== undefined && isNeverActivatedFailedUpdate(record);
  } catch {
    // Unreadable history cannot release a recovery source.
    return false;
  }
}

/** Route to a live Gateway rather than borrowing its lock or stopping it a second time. */
export async function automaticallyCleanUpdateRecovery(
  runId: string,
  env: NodeJS.ProcessEnv,
): Promise<UpdateStepResult | undefined> {
  try {
    return await withOwnedManagedUpdateEnv(env, () =>
      runWithLocalStateOwner({
        method: "update.recovery.cleanup",
        params: { runId },
        target: "completed update recovery artifacts",
        recoveryCommand: "openclaw update cleanup --dry-run",
        timeoutMs: 5 * 60_000,
        runLocal: async ({ env: selectedEnv, assertCurrent }) =>
          recordAutomaticRecoveryCleanup(
            runId,
            await cleanupCompletedUpdateRecovery(runId, selectedEnv, assertCurrent),
            selectedEnv,
            assertCurrent,
          ),
      }),
    );
  } catch (error) {
    // A refusal or uncertain RPC never authorizes offline fallback or rollback.
    return automaticRecoveryCleanupWarning(error);
  }
}
