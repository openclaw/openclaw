import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveUpdateCaptureRoot } from "../infra/update-capture-paths.js";
import { UPDATE_RUN_ID_ENV } from "../infra/update-control-plane-sentinel.js";
import {
  DoctorMaintenanceRefusalError,
  type UpdateDoctorWriteAuthority,
} from "../infra/update-doctor-result.js";
import { readUpdateRunDriver } from "../infra/update-run-driver.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveDoctorUpdateAdmission } from "./doctor-maintenance-admission.js";

// docker-entrypoint.mjs passes a container-local path. The marker names the capture
// this container already sealed, so later starts skip the full copy but keep it.
const IMAGE_ACTIVATION_MARKER_ENV = "OPENCLAW_IMAGE_ACTIVATION_CAPTURE_MARKER";
const STANDALONE_CAPTURE_RUN_ID =
  /^doctor-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** A marker counts only while the sealed capture it names is still retained. */
async function readImageActivationCapture(
  marker: string,
  captureRoot: string,
): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(marker);
    if (!stat.isFile() || (process.getuid !== undefined && stat.uid !== process.getuid())) {
      return undefined;
    }
    const runId = (await fs.readFile(marker, "utf8")).trim();
    if (!STANDALONE_CAPTURE_RUN_ID.test(runId)) {
      return undefined;
    }
    const manifest = await fs.lstat(path.join(captureRoot, runId, "manifest.json"));
    return manifest.isFile() ? runId : undefined;
  } catch {
    return undefined;
  }
}

/** Preserve evidence before repair; neither a capture nor its lineage authorizes restoration. */
export async function preserveDoctorOriginalState(params: {
  root: string | null;
  env: NodeJS.ProcessEnv;
  runtime: RuntimeEnv;
  signal: AbortSignal;
  assertCurrent: () => void;
  writeAuthority?: UpdateDoctorWriteAuthority;
  fullIntegrityCheck?: boolean;
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
          ? `Original update capture retained at ${retained.ref.manifestPath}.`
          : "Original update capture is unavailable. Doctor will repair current state without replacing the retained originals.",
      );
      return;
    }
    const { captureUpdateRecoveryBaseline } =
      await import("../infra/update-recovery-baseline-capture.js");
    const { retireExpiredStandaloneDoctorCaptures } =
      await import("../infra/doctor-capture-retention.js");
    const stateDir = resolvePathViaExistingAncestorSync(resolveStateDir(params.env));
    const retireExpiredCaptures = async (keepRunId: string) => {
      try {
        const retirement = await retireExpiredStandaloneDoctorCaptures({
          stateDir,
          env: params.env,
          keepRunId,
          assertCurrent,
        });
        for (const directory of retirement.retired) {
          params.runtime.log(
            `Retired superseded or expired standalone Doctor capture: ${directory}. Take a verified backup before an upgrade when you need a long-term recovery copy.`,
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
    };
    const activationMarker = params.env[IMAGE_ACTIVATION_MARKER_ENV]?.trim() || undefined;
    const activationCapture = activationMarker
      ? await readImageActivationCapture(activationMarker, resolveUpdateCaptureRoot(stateDir))
      : undefined;
    if (activationCapture) {
      assertCurrent();
      params.runtime.log(
        `This container already retained a pre-repair capture (${activationCapture}); Doctor skipped a repeated full capture. Repair-specific backups still apply.`,
      );
      await retireExpiredCaptures(activationCapture);
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
      fullIntegrityCheck: params.fullIntegrityCheck,
    });
    assertCurrent();
    params.runtime.log(
      `Pre-repair state retained for manual recovery at ${captured.ref.manifestPath}.`,
    );
    if (activationMarker) {
      try {
        await fs.rm(activationMarker, { force: true });
        await fs.writeFile(activationMarker, standaloneRunId, { flag: "wx", mode: 0o600 });
      } catch (error) {
        params.runtime.log(
          `Container activation marker unavailable: ${formatErrorMessage(error)}. The next container start takes another full capture.`,
        );
      }
    }
    await retireExpiredCaptures(standaloneRunId);
    for (const warning of captured.warnings) {
      params.runtime.log(warning.message);
    }
    for (const warning of captured.diagnostics.databaseWarnings) {
      params.runtime.log(warning);
    }
  } catch (error) {
    assertCurrent();
    if (
      hasCommandProcessCleanupError(error) ||
      (error instanceof DoctorMaintenanceRefusalError && error.refusal.kind === "deferred")
    ) {
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
