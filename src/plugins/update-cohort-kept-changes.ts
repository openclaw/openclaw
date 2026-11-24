import { PLUGIN_COHORT_KEPT_WARNING_STEP } from "../infra/update-run-codec.js";
import { getUpdateRun, recordUpdateRunDiagnostic } from "../infra/update-run-ledger.js";

const KEPT_PREFIX =
  "Update rollback kept newer changes made after the update instead of restoring them: ";
const KEPT_SUFFIX = ". Run openclaw doctor to review them.";

export function formatKeptChanges(items: readonly string[]): string {
  return `${KEPT_PREFIX}${items.join("; ")}${KEPT_SUFFIX}`;
}

/**
 * Merge into the run's kept-change warning. A resumed repair cannot recompute items
 * it already counted, so earlier entries must survive later writes.
 */
export function recordKeptChanges(runId: string, items: readonly string[], env: NodeJS.ProcessEnv) {
  const run = getUpdateRun(runId, { env });
  const prior = run?.steps.find((step) => step.step === PLUGIN_COHORT_KEPT_WARNING_STEP)?.detail;
  const recorded =
    prior?.startsWith(KEPT_PREFIX) && prior.endsWith(KEPT_SUFFIX)
      ? prior.slice(KEPT_PREFIX.length, -KEPT_SUFFIX.length).split("; ")
      : [];
  const warning = formatKeptChanges([...new Set([...recorded, ...items])]);
  // A pruned history has no run to annotate; settlement still completes.
  if (run) {
    recordUpdateRunDiagnostic(runId, warning, { env }, PLUGIN_COHORT_KEPT_WARNING_STEP);
  }
  return warning;
}
