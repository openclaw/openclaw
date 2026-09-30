import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "../infra/errors.js";
import { UPDATE_RUN_ID_ENV } from "../infra/update-control-plane-sentinel.js";
import type { UpdateDoctorWriteAuthority } from "../infra/update-doctor-result.js";
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
  const admission = updateInProgress
    ? resolveDoctorUpdateAdmission(params.env, original?.runId)
    : undefined;
  const assertCurrent = () => {
    assertCallerCurrent();
    admission?.assertCurrent();
  };
  try {
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
          ? `Original update capture retained at ${retained.ref.manifestPath}.`
          : "Original update capture is unavailable. Doctor will repair current state without replacing the retained originals.",
      );
      return;
    }
    if (!params.root) {
      throw new Error("The installation could not be identified for the pre-repair capture.");
    }
    const driver = readUpdateRunDriver();
    if (!driver) {
      throw new Error("The Doctor process could not be identified for the pre-repair capture.");
    }
    const { captureUpdateRecoveryBaseline } =
      await import("../infra/update-recovery-baseline-capture.js");
    assertCurrent();
    const captured = await captureUpdateRecoveryBaseline({
      runId: `doctor-${randomUUID()}`,
      installRoot: params.root,
      env: params.env,
      drivers: [driver],
      assertCurrent,
      signal: params.signal,
    });
    assertCurrent();
    params.runtime.log(
      `Pre-repair state retained for manual recovery at ${captured.ref.manifestPath}.`,
    );
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
    params.runtime.log(
      `Original state capture was unavailable: ${formatErrorMessage(error)}. Doctor will continue; inspect retained evidence manually before restoring state.`,
    );
  }
}
