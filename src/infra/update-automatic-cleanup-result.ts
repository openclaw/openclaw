import { formatErrorMessage } from "./errors.js";
import { isNeverActivatedFailedUpdate } from "./update-run-activation.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";
import { recordUpdateRunStepAsync } from "./update-run-write.async.js";
import type { UpdateStepResult } from "./update-step-result.js";

export const AUTOMATIC_RECOVERY_CLEANUP_STEP = "recovery-artifact-cleanup";

/** Every finished run may release older backups; each artifact's own rule decides. */
export function canAutomaticallyCleanUpdateRecovery(run: UpdateRunRecord): boolean {
  return (
    run.finishedAtMs !== null &&
    (run.status === "succeeded" ||
      run.status === "failed" ||
      run.status === "rolled-back" ||
      (run.status === "skipped" && run.reason === "already-current") ||
      isNeverActivatedFailedUpdate(run))
  );
}

/**
 * A recorded cleanup is final unless the run's health verification landed after it: a
 * cleanup that ran before verification could not release the run's own backups yet.
 */
export function hasSettledAutomaticRecoveryCleanup(run: UpdateRunRecord): boolean {
  const step = run.steps.find(
    (entry) => entry.step === AUTOMATIC_RECOVERY_CLEANUP_STEP && entry.status === "completed",
  );
  return (
    step !== undefined &&
    // Older receipts carry no time, so they cannot prove they ran after verification.
    !(
      run.confirmedAtMs !== null &&
      (step.endedAtMs === undefined || run.confirmedAtMs > step.endedAtMs)
    )
  );
}

export function automaticRecoveryCleanupWarning(error: unknown): UpdateStepResult {
  const message = `Automatic recovery cleanup did not finish: ${formatErrorMessage(error)}. The update outcome is unchanged; retained artifacts can be inspected with openclaw update cleanup --dry-run.`;
  return {
    name: AUTOMATIC_RECOVERY_CLEANUP_STEP,
    command: "openclaw update cleanup",
    cwd: "",
    durationMs: 0,
    exitCode: 0,
    advisory: { kind: "recoverable-maintenance", message },
  };
}

export async function recordAutomaticRecoveryCleanup(
  runId: string,
  result: UpdateStepResult | undefined,
  env: NodeJS.ProcessEnv,
  assertCurrent: () => void,
): Promise<UpdateStepResult | undefined> {
  if (!result) {
    return undefined;
  }
  try {
    // The run record keeps one fixed report: the summary and the warning. A rerun after late
    // verification overwrites both, so no line from the earlier report survives it; the
    // per-item lines stay in the update result and `openclaw update cleanup --dry-run`.
    const [completed, ...steps] = updateRunStepsFromResultStep(result);
    const warningStep = `warning:${AUTOMATIC_RECOVERY_CLEANUP_STEP}`;
    const details = steps.filter(
      (step) =>
        step.step === warningStep || step.step === `diagnostic:${AUTOMATIC_RECOVERY_CLEANUP_STEP}`,
    );
    if (!details.some((step) => step.step === `diagnostic:${AUTOMATIC_RECOVERY_CLEANUP_STEP}`)) {
      // A warning-only attempt replaces the earlier summary instead of pairing with it.
      details.push({
        step: `diagnostic:${AUTOMATIC_RECOVERY_CLEANUP_STEP}`,
        status: "completed",
        detail: "Update backup cleanup did not finish on its latest attempt; see its warning.",
      });
    }
    if (result.warnings?.length === 0 && !result.advisory) {
      // A settled rerun clears the earlier warning instead of leaving it to count.
      details.push({ step: warningStep, status: "skipped", detail: undefined });
    }
    // Record completion last: a crash before diagnostics settle leaves a safe retry.
    for (const step of [...details, { ...completed!, endedAtMs: Date.now() }]) {
      const saved = await recordUpdateRunStepAsync(runId, step, { env, assertCurrent });
      if (!saved) {
        throw new Error("Cleanup bookkeeping was not recorded");
      }
    }
  } catch (error) {
    const warning = automaticRecoveryCleanupWarning(error).advisory!.message;
    if (result.warnings !== undefined) {
      result.warnings = [...result.warnings, warning];
    }
    result.advisory = {
      kind: "recoverable-maintenance",
      message: [result.advisory?.message, warning].filter(Boolean).join(" "),
    };
  }
  return result;
}
