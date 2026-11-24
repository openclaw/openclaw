import { isDeepStrictEqual } from "node:util";
import { formatUpdateRunOwnership } from "../infra/update-run-activity.js";
import {
  acknowledgeAbandonedUpdateRun,
  getUpdateRun,
  reconcileAbandonedUpdateRunsAsync,
} from "../infra/update-run-ledger.js";
import {
  LEGACY_TRIAL_READY,
  readLegacyTrialReceipt,
  recoverableLegacyTrial,
} from "./legacy-trial-record.js";
import { completeLegacyTrialRepair } from "./legacy-trial.js";

/** Capture before maintenance; only the matching ready receipt may arrive during restoration. */
export function prepareUpdateRepairHistory(runIds: readonly string[]) {
  const legacyTrials = runIds.flatMap((runId) => {
    const run = getUpdateRun(runId);
    return run && recoverableLegacyTrial(run, false) ? [run] : [];
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
      let legacy = legacyTrials.find((run) => run.runId === runId);
      const current = legacy ? getUpdateRun(runId) : undefined;
      if (current?.status === "succeeded") {
        continue;
      }
      if (legacy && !readLegacyTrialReceipt(legacy, true)) {
        if (
          current &&
          isDeepStrictEqual(
            {
              ...current,
              updatedAtMs: legacy.updatedAtMs,
              steps: current.steps.filter((step) => step.step !== LEGACY_TRIAL_READY),
            },
            legacy,
          )
        ) {
          legacy = current;
        }
      }
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
