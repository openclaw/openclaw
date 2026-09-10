import { formatErrorMessage } from "./errors.js";
import { inspectUpdateRunAbandonment, staleUpdateRunGuidance } from "./update-run-activity.js";
import {
  findActiveUpdateRun,
  listUpdateRuns,
  reconcileAbandonedUpdateRuns,
} from "./update-run-ledger.js";
import {
  LEGACY_UPDATE_RUN_ADVISORY,
  LEGACY_UPDATE_RUN_EXPIRED_REASON,
} from "./update-run-legacy-expiry.js";

/** Status heals the bounded legacy defect while other recovery keeps its existing owner. */
export function readUpdateRunStatus() {
  let runReconciliationError: string | undefined;
  try {
    reconcileAbandonedUpdateRuns({ legacyOnly: true });
  } catch (error) {
    runReconciliationError = formatErrorMessage(error);
  }
  try {
    const activeRun = findActiveUpdateRun();
    const lastRun = listUpdateRuns({ limit: 1 })[0];
    const abandonment = activeRun ? inspectUpdateRunAbandonment(activeRun) : undefined;
    const staleGuidance = activeRun ? staleUpdateRunGuidance(activeRun) : undefined;
    const expired = listUpdateRuns({ limit: 1, reason: LEGACY_UPDATE_RUN_EXPIRED_REASON })[0];
    return {
      ...(runReconciliationError ? { runReconciliationError } : {}),
      ...(activeRun ? { activeRun } : {}),
      ...(lastRun ? { lastRun } : {}),
      ...(staleGuidance && activeRun
        ? { staleRun: { runId: activeRun.runId, guidance: staleGuidance } }
        : {}),
      ...(abandonment && abandonment !== LEGACY_UPDATE_RUN_EXPIRED_REASON && activeRun
        ? { abandonedRun: { runId: activeRun.runId, rule: abandonment } }
        : {}),
      ...(expired
        ? {
            advisories: [
              {
                runId: expired.runId,
                reason: LEGACY_UPDATE_RUN_EXPIRED_REASON,
                message: LEGACY_UPDATE_RUN_ADVISORY,
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
