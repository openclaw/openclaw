import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../state/openclaw-state-db-readonly.js";
import { canReconcileUpdateRunCandidates } from "./update-run-read.kernel.js";
import type { reconcileAbandonedUpdateRunsAsync } from "./update-run-reconciliation.js";
import {
  readUpdateRunReconciliationCandidates,
  reconcileUpdateRunCandidatesInWorker,
} from "./update-run-reconciliation.worker.js";

/** Native-kernel policy coverage shares the fixture clock and PID observations; worker transport is tested separately. */
export function reconcileUpdateRunsInNativeKernelForTest(
  input: Parameters<typeof reconcileAbandonedUpdateRunsAsync>[0] = {},
  options: Parameters<typeof reconcileAbandonedUpdateRunsAsync>[1] = {},
) {
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
  };
  assertCurrent();
  const candidates =
    withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
      ({ db }) => readUpdateRunReconciliationCandidates(db, input),
      options,
    ) ?? [];
  if (
    !canReconcileUpdateRunCandidates(candidates, input) &&
    input.repairHistorySinceMs === undefined
  ) {
    return [];
  }
  return reconcileUpdateRunCandidatesInWorker(
    {
      candidates,
      selection: input,
      busyTimeoutMs: options.busyTimeoutMs,
      redactPaths: options.redactPaths,
    },
    options,
    assertCurrent,
  ).reconciled;
}
