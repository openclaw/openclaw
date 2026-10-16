import { formatErrorMessage } from "./errors.js";
import { inspectUpdateRunAbandonment, staleUpdateRunGuidance } from "./update-run-activity.js";
import { reconcileAbandonedUpdateRunsAsync } from "./update-run-ledger.js";
import {
  LEGACY_UPDATE_RUN_ADVISORY,
  LEGACY_UPDATE_RUN_EXPIRED_REASON,
} from "./update-run-legacy-expiry.js";
import { getUpdateRunHistoryStatusAsync } from "./update-run-reader.js";
import { isAcknowledgedAbandonedUpdateRun, toPublicUpdateRun } from "./update-run-record.js";

/** Status heals the bounded legacy defect while other recovery keeps its existing owner. */
export async function readUpdateRunStatus() {
  let runReconciliationError: string | undefined;
  try {
    await reconcileAbandonedUpdateRunsAsync({ legacyOnly: true });
  } catch (error) {
    runReconciliationError = formatErrorMessage(error);
  }
  try {
    const { activeRun, lastRun, expiredRun: expired } = await getUpdateRunHistoryStatusAsync();
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
        ? { abandonedRun: { runId: activeRun.runId, rule: abandonment } }
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
