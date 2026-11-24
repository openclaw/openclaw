import { formatUpdateRunOwnership } from "../infra/update-run-activity.js";
import {
  acknowledgeAbandonedUpdateRun,
  getUpdateRun,
  reconcileAbandonedUpdateRunsAsync,
} from "../infra/update-run-ledger.js";
import { recoverableLegacyTrial } from "./legacy-trial-record.js";
import { completeLegacyTrialRepair } from "./legacy-trial.js";

/** Capture before maintenance; a later write to the original row must not be regraded. */
export function prepareUpdateRepairHistory(runIds: readonly string[]) {
  const legacyTrials = runIds.flatMap((runId) => {
    const run = getUpdateRun(runId);
    return run && recoverableLegacyTrial(run) ? [run] : [];
  });
  return async (repairRunId: string, root: string, allowCorrection: boolean): Promise<string[]> => {
    await reconcileAbandonedUpdateRunsAsync({ explicit: true, runIds });
    const unresolved = runIds
      .map((runId) => getUpdateRun(runId))
      .find((run) => run?.status === "running");
    if (unresolved) {
      throw new Error(formatUpdateRunOwnership(unresolved));
    }
    const reconciled: string[] = [];
    for (const runId of runIds) {
      const legacy = legacyTrials.find((run) => run.runId === runId);
      if (legacy) {
        if (allowCorrection && (await completeLegacyTrialRepair(legacy, repairRunId, root))) {
          reconciled.push(runId);
        } else {
          // A changed row or unavailable serving proof must remain selectable on retry.
          console.warn(
            `Update ${runId}: completion history was not verified; its existing outcome was preserved. Retry openclaw update repair after the recorded build is serving.`,
          );
        }
      } else if (acknowledgeAbandonedUpdateRun(runId)) {
        // Repairing today's install does not erase an uncorrelated historical failure.
        reconciled.push(runId);
      }
    }
    return reconciled;
  };
}
