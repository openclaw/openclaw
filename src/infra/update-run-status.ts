import { formatErrorMessage } from "./errors.js";
import { inspectUpdateRunAbandonment, staleUpdateRunGuidance } from "./update-run-activity.js";
import { reconcileAbandonedUpdateRunsAsync } from "./update-run-ledger.js";
import {
  LEGACY_UPDATE_RUN_ADVISORY,
  LEGACY_UPDATE_RUN_EXPIRED_REASON,
} from "./update-run-legacy-expiry.js";
import {
  selectUpdateOwedSteps,
  UPDATE_OWED_STEP_HISTORY,
  type UpdateOwedStep,
} from "./update-run-owed-step.js";
import { getUpdateRunHistoryStatusAsync, listUpdateRunsAsync } from "./update-run-reader.js";
import { isAcknowledgedAbandonedUpdateRun, toPublicUpdateRun } from "./update-run-record.js";

/** Owed steps enrich status from the same post-healing view; `onStatus` keeps it if enrichment stalls. */
export async function readUpdateRunStatusWithOwedSteps(
  onStatus: (status: UpdateRunStatus) => void,
): Promise<UpdateRunStatus & { owedSteps?: UpdateOwedStep[] }> {
  let healed = false;
  const status = await readUpdateRunStatus(() => {
    healed = true;
  });
  onStatus(status);
  if (!("lastRun" in status) || !status.lastRun) {
    return status;
  }
  // An earlier run can still owe a step after a later one replaced it as the last run.
  const owedSteps = await listUpdateRunsAsync(
    { limit: UPDATE_OWED_STEP_HISTORY },
    {},
    { current: healed },
  ).then(selectUpdateOwedSteps, () => []);
  return owedSteps.length ? { ...status, owedSteps } : status;
}

type UpdateRunStatus = Awaited<ReturnType<typeof readUpdateRunStatus>>;

/** Status heals expired admissions and proven handoff death; other driver loss stays descriptive. */
export async function readUpdateRunStatus(onHealed?: () => void) {
  let runReconciliationError: string | undefined;
  let healed = false;
  try {
    healed = (await reconcileAbandonedUpdateRunsAsync({ statusOnly: true })).length > 0;
    if (healed) {
      onHealed?.();
    }
  } catch (error) {
    runReconciliationError = formatErrorMessage(error);
  }
  try {
    // An enclosing inspection image predates this healing commit; report the healed rows.
    const {
      activeRun,
      lastRun,
      expiredRun: expired,
    } = await getUpdateRunHistoryStatusAsync({}, { current: healed });
    const abandonment = activeRun ? inspectUpdateRunAbandonment(activeRun) : undefined;
    const staleGuidance = activeRun ? staleUpdateRunGuidance(activeRun) : undefined;
    return {
      ...(runReconciliationError ? { runReconciliationError } : {}),
      ...(activeRun ? { activeRun: toPublicUpdateRun(activeRun) } : {}),
      ...(lastRun ? { lastRun: toPublicUpdateRun(lastRun) } : {}),
      ...(staleGuidance && activeRun
        ? { staleRun: { runId: activeRun.runId, guidance: staleGuidance } }
        : {}),
      ...(abandonment && abandonment !== LEGACY_UPDATE_RUN_EXPIRED_REASON && activeRun
        ? {
            abandonedRun: {
              runId: activeRun.runId,
              rule: abandonment,
              nextAction: "Run `openclaw update repair` before retrying the update.",
            },
          }
        : {}),
      ...(expired && !isAcknowledgedAbandonedUpdateRun(expired)
        ? {
            advisories: [
              {
                runId: expired.runId,
                reason: LEGACY_UPDATE_RUN_EXPIRED_REASON,
                // Retain historical notices without prescribing a retry for another current run.
                message:
                  expired.runId === (activeRun ?? lastRun)?.runId
                    ? LEGACY_UPDATE_RUN_ADVISORY
                    : "Historical update: a 2026.9.2-era update never progressed past admission and was treated as abandoned after 24 h.",
              },
            ],
          }
        : {}),
    };
  } catch (error) {
    // An unavailable history read is not an empty ledger.
    return { runStatusError: formatErrorMessage(error) };
  }
}
