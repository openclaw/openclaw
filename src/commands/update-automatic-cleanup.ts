import { createConfigIO } from "../config/io.js";
import {
  AUTOMATIC_RECOVERY_CLEANUP_STEP,
  canAutomaticallyCleanUpdateRecovery,
  automaticRecoveryCleanupWarning,
} from "../infra/update-automatic-cleanup-result.js";
import { isNeverActivatedFailedUpdate } from "../infra/update-run-activation.js";
import { getUpdateRun } from "../infra/update-run-reader.js";
import type { UpdateStepResult } from "../infra/update-step-result.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireOwnedSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";

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
    if (
      run.steps.some(
        (step) => step.step === AUTOMATIC_RECOVERY_CLEANUP_STEP && step.status === "completed",
      )
    ) {
      const message = run.steps.find(
        (step) => step.step === `warning:${AUTOMATIC_RECOVERY_CLEANUP_STEP}`,
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
    // A failure that never activated releases its own capture along with superseded recovery.
    const ownCaptureReleased = isNeverActivatedFailedUpdate(run);
    const io = createConfigIO({ env, observe: false, pluginValidation: "core-only" });
    const readConfig = () => io.readSourceConfigBestEffort();
    const preview = inspectSessionSqliteRecovery({ cfg: await readConfig(), env });
    assertCurrent();
    const report = await retireOwnedSessionSqliteRecovery(
      {
        env,
        preview,
        readConfig,
        confirm: async (verified) => {
          // Backward clock adjustments must not make this run its own successor.
          if (
            !ownCaptureReleased &&
            verified.artifacts.some(
              (item) =>
                item.kind === "update-capture" &&
                item.outcome === "candidate" &&
                item.runs.includes(runId),
            )
          ) {
            throw new Error(
              "The triggering update's own capture must be retained; cleanup deferred",
            );
          }
          return true;
        },
        verifyHistorical: false,
      },
      { assertCurrent },
    );
    const retained = report.artifacts.filter(
      (item) =>
        ["blocked", "failed", "candidate", "verification-required"].includes(item.outcome) ||
        item.reason === "unreadable-update-history" ||
        item.reason === "historical-manifest-without-import-proof" ||
        item.reason === "historical-recovery-dependencies-unverified",
    );
    const summary = `Recovery cleanup removed ${report.totals.removedFiles} files (${report.totals.removedBytes} logical bytes); protected recovery artifacts were retained.`;
    return {
      name: AUTOMATIC_RECOVERY_CLEANUP_STEP,
      command: "openclaw update cleanup",
      cwd: "",
      durationMs: Math.max(0, Date.now() - startedAt),
      exitCode: 0,
      diagnostics: [summary],
      ...(retained.length
        ? {
            advisory: {
              kind: "recoverable-maintenance" as const,
              message: `${summary} Not fully retired: ${retained.map((item) => `${item.path} (${item.reason}${item.detail ? `: ${item.detail}` : ""})`).join("; ")}. Inspect with openclaw update cleanup --dry-run.`,
            },
          }
        : {}),
    };
  } catch (error) {
    return {
      ...automaticRecoveryCleanupWarning(error),
      durationMs: Math.max(0, Date.now() - startedAt),
    };
  }
}
