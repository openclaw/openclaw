import { randomUUID } from "node:crypto";
import { resolveStateDir } from "../config/paths.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { formatErrorMessage } from "../infra/errors.js";
import { UPDATE_RUN_ID_ENV } from "../infra/update-control-plane-sentinel.js";
import {
  DoctorMaintenanceRefusalError,
  type UpdateDoctorWriteAuthority,
} from "../infra/update-doctor-result.js";
import { readUpdateRunDriver } from "../infra/update-run-driver.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveDoctorUpdateAdmission } from "./doctor-maintenance-admission.js";

/** Preserve evidence before repair; neither a capture nor its lineage authorizes restoration. */
export async function preserveDoctorOriginalState(params: {
  root: string | null;
  env: NodeJS.ProcessEnv;
  runtime: RuntimeEnv;
  signal: AbortSignal;
  assertCurrent: () => void;
  writeAuthority?: UpdateDoctorWriteAuthority;
}): Promise<void> {
  const original = params.writeAuthority?.originalRecoveryCapture;
  const runId = original?.runId ?? params.env[UPDATE_RUN_ID_ENV]?.trim();
  const updateInProgress = original !== undefined || params.env.OPENCLAW_UPDATE_IN_PROGRESS === "1";
  const assertCallerCurrent = () => {
    params.signal.throwIfAborted();
    params.assertCurrent();
    params.writeAuthority?.assertCurrent();
  };
  assertCallerCurrent();
  if (updateInProgress && !runId) {
    params.runtime.log(
      "Original update capture is unavailable. Doctor will repair current state without replacing the retained originals.",
    );
    return;
  }
  let admission: ReturnType<typeof resolveDoctorUpdateAdmission> | undefined;
  const assertCurrent = () => {
    assertCallerCurrent();
    admission?.assertCurrent();
  };
  try {
    // Older drivers may lack capture lineage; repair keeps its live maintenance and write authority.
    admission = updateInProgress
      ? resolveDoctorUpdateAdmission(params.env, original?.runId)
      : undefined;
    if (admission && runId) {
      const { readUpdateRecoveryBaselineIdentity } =
        await import("../infra/update-recovery-backup-reader.js");
      assertCurrent();
      const retained = await readUpdateRecoveryBaselineIdentity({
        runId,
        env: params.env,
        ...(original ? { ref: original.ref, installRoot: original.installRoot } : {}),
        readContinuation: admission.readContinuation,
        assertCurrent,
      });
      assertCurrent();
      params.runtime.log(
        retained
          ? `Original update recovery copy retained. No action needed. For manual recovery: ${retained.ref.manifestPath}.`
          : "Original update capture is unavailable. Doctor will repair current state without replacing the retained originals.",
      );
      return;
    }
    const installRoot = params.root;
    if (!installRoot) {
      throw new Error("The installation could not be identified for the pre-repair capture.");
    }
    const driver = readUpdateRunDriver();
    if (!driver) {
      throw new Error("The Doctor process could not be identified for the pre-repair capture.");
    }
    const { captureUpdateRecoveryBaseline, retireExpiredStandaloneDoctorCaptures } =
      await import("../infra/update-recovery-baseline-capture.js");
    assertCurrent();
    const standaloneRunId = `doctor-${randomUUID()}`;
    const captured = await captureUpdateRecoveryBaseline({
      runId: standaloneRunId,
      installRoot,
      env: params.env,
      drivers: [driver],
      assertCurrent,
      signal: params.signal,
      acquisition: { mode: "maintenance-owner" },
    });
    assertCurrent();
    params.runtime.log(
      `Recovery copy saved before repair. No action needed. For manual recovery: ${captured.ref.manifestPath}.`,
    );
    try {
      const retirement = await retireExpiredStandaloneDoctorCaptures({
        stateDir: resolvePathViaExistingAncestorSync(resolveStateDir(params.env)),
        keepRunId: standaloneRunId,
        assertCurrent,
      });
      for (const directory of retirement.retired) {
        params.runtime.log(
          `Retired standalone Doctor capture older than 30 days: ${directory}. Take a verified backup before an upgrade when you need a long-term recovery copy.`,
        );
      }
      for (const warning of retirement.warnings) {
        params.runtime.log(warning);
      }
    } catch (error) {
      params.runtime.log(
        `Standalone Doctor capture retirement unavailable: ${formatErrorMessage(error)}`,
      );
    }
    for (const warning of captured.warnings) {
      params.runtime.log(warning.message);
    }
    for (const warning of captured.diagnostics.databaseWarnings) {
      params.runtime.log(warning);
    }
  } catch (error) {
    assertCurrent();
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    if (original?.ref) {
      // An admitted baseline is part of this repair's contract, not optional
      // diagnostics. Never replace lost evidence with a capture of changed state.
      throw new DoctorMaintenanceRefusalError(
        `Doctor cannot verify its admitted original update capture: ${formatErrorMessage(error)}. State repair has not started. Inspect retained evidence with openclaw update status --json before retrying Doctor.`,
        { kind: "data-at-risk", reason: "unreadable-state" },
        { cause: error },
      );
    }
    params.runtime.log(
      `Original state capture was unavailable: ${formatErrorMessage(error)}. Doctor will continue; inspect retained evidence manually before restoring state.`,
    );
  }
}
