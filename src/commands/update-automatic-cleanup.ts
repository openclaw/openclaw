import { createConfigIO } from "../config/io.js";
import {
  AUTOMATIC_RECOVERY_CLEANUP_STEP,
  canAutomaticallyCleanUpdateRecovery,
  automaticRecoveryCleanupWarning,
  hasSettledAutomaticRecoveryCleanup,
} from "../infra/update-automatic-cleanup-result.js";
import { isNeverActivatedFailedUpdate } from "../infra/update-run-activation.js";
import { getUpdateRun } from "../infra/update-run-reader.js";
import { isUpdateRecoveryPending } from "../infra/update-run-recovery-schema.js";
import { inspectUpdateRecoveries } from "../infra/update-run-recovery.js";
import type { UpdateStepResult } from "../infra/update-step-result.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireOwnedSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import { describeAutomaticCleanup } from "./update-automatic-cleanup-report.js";
import { isUnchangedUpdate, isVerifiedSuccessfulUpdate } from "./update-capture-cleanup.js";

const RESOLVED_WARNING = "An earlier cleanup warning was resolved by a later cleanup.";

/** Called only inside the selected state owner's lifetime, after durable completion. */
export async function cleanupCompletedUpdateRecovery(
  runId: string,
  env: NodeJS.ProcessEnv,
  assertCurrent: () => void,
): Promise<UpdateStepResult | undefined> {
  const startedAt = Date.now();
  try {
    assertCurrent();
    const run = getUpdateRun(runId, { env });
    if (!run || !canAutomaticallyCleanUpdateRecovery(run)) {
      return undefined;
    }
    // After an activated failure, older backup sets go only once no recovery is pending.
    if (
      !isNeverActivatedFailedUpdate(run) &&
      (run.status === "failed" || run.status === "rolled-back") &&
      inspectUpdateRecoveries({ env }).some(({ record }) => isUpdateRecoveryPending(record))
    ) {
      return undefined;
    }
    if (hasSettledAutomaticRecoveryCleanup(run)) {
      const message = run.steps.find(
        (step) =>
          step.step === `warning:${AUTOMATIC_RECOVERY_CLEANUP_STEP}` && step.status === "completed",
      )?.detail;
      const detail = run.steps.find(
        (step) => step.step === `diagnostic:${AUTOMATIC_RECOVERY_CLEANUP_STEP}`,
      )?.detail;
      return {
        name: AUTOMATIC_RECOVERY_CLEANUP_STEP,
        command: "openclaw update cleanup",
        cwd: "",
        durationMs: 0,
        exitCode: 0,
        ...(message ? { advisory: { kind: "recoverable-maintenance", message } } : {}),
        ...(detail ? { diagnostics: [detail] } : {}),
      };
    }
    // A failure that never activated, an already-current run, or a verified healthy success
    // releases its own capture.
    const ownCaptureReleased =
      isNeverActivatedFailedUpdate(run) ||
      isUnchangedUpdate(run) ||
      isVerifiedSuccessfulUpdate(run);
    const io = createConfigIO({ env, observe: false, pluginValidation: "core-only" });
    const readConfig = () => io.readSourceConfigBestEffort();
    const preview = await inspectSessionSqliteRecovery({ cfg: await readConfig(), env });
    assertCurrent();
    const report = await retireOwnedSessionSqliteRecovery(
      {
        env,
        preview,
        readConfig,
        confirm: async (verified) => {
          // Backward clock adjustments must not make this run its own successor. Only its
          // own verified success releases its backups, and nothing releases its own
          // database snapshot: that waits for a later verified update.
          if (
            verified.artifacts.some(
              (item) =>
                item.outcome === "candidate" &&
                item.runs.includes(runId) &&
                !(item.kind === "update-capture"
                  ? ownCaptureReleased
                  : item.kind !== "database-snapshot" && isVerifiedSuccessfulUpdate(run)),
            )
          ) {
            throw new Error(
              "The triggering update's own capture or backups must be retained; cleanup deferred",
            );
          }
          return true;
        },
        verifyHistorical: false,
        allowOwnedDestinationMutation: true,
      },
      { assertCurrent },
    );
    const { diagnostics, warning } = describeAutomaticCleanup(report.artifacts);
    // A rerun replaces the earlier report; an earlier warning it no longer has is resolved.
    const resolved =
      !warning &&
      run.steps.some(
        (step) =>
          step.step === `warning:${AUTOMATIC_RECOVERY_CLEANUP_STEP}` && step.status === "completed",
      );
    // A failed update's own result already names what it keeps; add only real effects.
    if (
      !ownCaptureReleased &&
      (run.status === "failed" || run.status === "rolled-back") &&
      !warning &&
      !report.artifacts.some((item) => item.removedBytes !== undefined)
    ) {
      return undefined;
    }
    return {
      name: AUTOMATIC_RECOVERY_CLEANUP_STEP,
      command: "openclaw update cleanup",
      cwd: "",
      durationMs: Math.max(0, Date.now() - startedAt),
      exitCode: 0,
      // An empty warning list settles an earlier warning; the note stays a diagnostic.
      diagnostics: resolved ? [...diagnostics, RESOLVED_WARNING] : diagnostics,
      ...(resolved ? { warnings: [] } : {}),
      // Failed deletions and unverifiable state are warnings; policy keeps are diagnostics.
      ...(warning
        ? { advisory: { kind: "recoverable-maintenance" as const, message: warning } }
        : {}),
    };
  } catch (error) {
    return {
      ...automaticRecoveryCleanupWarning(error),
      durationMs: Math.max(0, Date.now() - startedAt),
    };
  }
}
