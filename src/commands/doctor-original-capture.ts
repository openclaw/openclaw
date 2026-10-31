import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveUpdateCaptureRoot } from "../infra/update-capture-paths.js";
import { UPDATE_RUN_ID_ENV } from "../infra/update-control-plane-sentinel.js";
import {
  DoctorMaintenanceRefusalError,
  type UpdateDoctorWriteAuthority,
} from "../infra/update-doctor-result.js";
import { readUpdateRunDriver } from "../infra/update-run-driver.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveDoctorUpdateAdmission } from "./doctor-maintenance-admission.js";

// docker-entrypoint.mjs passes a container-local path. The marker names the capture
// this container already sealed, so later starts skip the full copy but keep it.
const IMAGE_ACTIVATION_MARKER_ENV = "OPENCLAW_IMAGE_ACTIVATION_CAPTURE_MARKER";
const STANDALONE_CAPTURE_RUN_ID =
  /^doctor-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
// Twice the measured 258 s Doctor on slow hardware, rounded up; repair backups still apply.
const ORIGINAL_CAPTURE_TIMEOUT_MS = 10 * 60_000;

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
}): Promise<{ findings: readonly HealthFinding[]; warnings: readonly string[] }> {
  const log = createSubsystemLogger("doctor");
  const findings: HealthFinding[] = [];
  const warnings: string[] = [];
  const docsUrl =
    "https://docs.openclaw.ai/cli/doctor/state-migrations#plugin-migration-recovery-coverage";
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
    log.debug(
      "Original update recovery copy is unavailable. Doctor will continue without creating another copy or replacing retained originals.",
    );
    return { findings, warnings };
  }
  let admission: ReturnType<typeof resolveDoctorUpdateAdmission> | undefined;
  const assertCurrent = () => {
    assertCallerCurrent();
    admission?.assertCurrent();
  };
  try {
    // Older drivers may lack capture lineage; repair keeps its live maintenance and write authority.
    admission =
      updateInProgress && runId
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
      log.debug(
        retained
          ? `Original update recovery copy retained. For manual recovery: ${retained.ref.manifestPath}.`
          : "Original update recovery copy is unavailable. Doctor will continue without creating another copy or replacing retained originals.",
      );
      return { findings, warnings };
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
          log.debug(
            `Retired superseded or expired standalone Doctor capture: ${directory}. Take a verified backup before an upgrade when you need a long-term recovery copy.`,
          );
        }
        for (const warning of retirement.warnings) {
          warnings.push(warning);
          findings.push({
            checkId: "core/doctor/recovery-retirement",
            severity: "warning",
            category: "historical",
            message: warning,
            docsUrl,
            fixHint:
              "Keep the retained recovery data. Inspect the named directory and its permissions before manual recovery.",
          });
        }
      } catch (error) {
        log.debug(`Standalone Doctor capture retirement unavailable: ${formatErrorMessage(error)}`);
      }
    };
    const activationMarker = params.env[IMAGE_ACTIVATION_MARKER_ENV]?.trim() || undefined;
    const activationCapture = activationMarker
      ? await readImageActivationCapture(activationMarker, resolveUpdateCaptureRoot(stateDir))
      : undefined;
    if (activationCapture) {
      assertCurrent();
      log.debug(
        `This container already retained a pre-repair capture (${activationCapture}); Doctor skipped a repeated full capture. Repair-specific backups still apply.`,
      );
      await retireExpiredCaptures(activationCapture);
      return { findings, warnings };
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
    const { findReusableDoctorCapture } = await import("../infra/doctor-capture-reuse.js");
    const controller = new AbortController();
    const deadline = performance.now() + ORIGINAL_CAPTURE_TIMEOUT_MS;
    const timeout = new Error("Original-state capture timed out after 600 s");
    const timer = setTimeout(() => controller.abort(timeout), ORIGINAL_CAPTURE_TIMEOUT_MS);
    timer.unref();
    let captured: Awaited<ReturnType<typeof captureUpdateRecoveryBaseline>>;
    let reused: Awaited<ReturnType<typeof findReusableDoctorCapture>>;
    let standaloneRunId: string;
    try {
      const assertCaptureCurrent = () => {
        // Synchronous admission/hash work must also observe the deadline before its timer fires.
        if (performance.now() >= deadline) {
          controller.abort(timeout);
        }
        controller.signal.throwIfAborted();
        assertCurrent();
      };
      const signal = AbortSignal.any([params.signal, controller.signal]);
      // Explicit full verification keeps its database-integrity work. Ordinary
      // repair can retain the newest standalone original only after exact proof.
      reused = params.fullIntegrityCheck
        ? undefined
        : await findReusableDoctorCapture({
            stateDir,
            installRoot,
            env: params.env,
            assertCurrent: assertCaptureCurrent,
            signal,
          });
      assertCaptureCurrent();
      standaloneRunId = reused ? path.basename(reused.directory) : `doctor-${randomUUID()}`;
      // Await cancellation settlement; racing a timeout could release repair while copies still run.
      captured = reused
        ? { ref: reused, warnings: [], diagnostics: { databaseWarnings: [] } }
        : await captureUpdateRecoveryBaseline({
            runId: standaloneRunId,
            installRoot,
            env: params.env,
            drivers: [driver],
            assertCurrent: assertCaptureCurrent,
            signal,
            acquisition: { mode: "maintenance-owner" },
            fullIntegrityCheck: params.fullIntegrityCheck,
          });
      assertCaptureCurrent();
    } finally {
      clearTimeout(timer);
    }
    warnings.push(...captured.warnings.map((warning) => warning.message));
    findings.push(
      ...captured.warnings.map((warning): HealthFinding => ({
        checkId: "core/doctor/migration-recovery",
        severity: "warning",
        category: "recommended",
        message:
          warning.kind === "undeclared-migration-resources"
            ? `${warning.pluginId} migration recovery coverage is unknown because no backup inventory was declared.`
            : warning.message,
        target: warning.pluginId,
        errorCode: warning.kind,
        fixHint:
          "Update the plugin to a version with migration backup support. Until then, keep a separate backup of its configured data before relying on rollback; ask its maintainer to add backup support.",
        docsUrl,
      })),
    );
    log.debug(
      reused
        ? `Unchanged original recovery copy verified and retained before repair. For manual recovery: ${captured.ref.manifestPath}.`
        : `Recovery copy saved before repair. No action needed. For manual recovery: ${captured.ref.manifestPath}.`,
    );
    if (activationMarker) {
      try {
        await fs.rm(activationMarker, { force: true });
        await fs.writeFile(activationMarker, standaloneRunId, { flag: "wx", mode: 0o600 });
      } catch (error) {
        params.runtime.log(
          `Container activation marker unavailable: ${formatErrorMessage(error)}. The next container start takes another full capture. Check write permissions for the container activation marker before restarting.`,
        );
      }
    }
    await retireExpiredCaptures(standaloneRunId);
    warnings.push(...captured.diagnostics.databaseWarnings);
    findings.push(
      ...captured.diagnostics.databaseWarnings.map((message): HealthFinding => ({
        checkId: "core/doctor/recovery-database-verification",
        severity: "warning",
        category: "recommended",
        message,
        docsUrl: "https://docs.openclaw.ai/cli/update/repair-and-recovery#original-state-captures",
        fixHint:
          "Keep the saved recovery copy. Check disk space and stop other OpenClaw processes before creating another verified backup; inspect the named database snapshot before manual restoration.",
      })),
    );
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
        `Doctor could not verify its admitted original recovery copy: ${formatErrorMessage(error)}. State repair has not started. Keep the original recovery copy, check the named paths and disk space, then inspect openclaw update status --json before retrying Doctor.`,
        { kind: "data-at-risk", reason: "unreadable-state" },
        { cause: error },
      );
    }
    const message = `Pre-repair recovery copy was unavailable: ${formatErrorMessage(error)}.`;
    const fixHint =
      "Save a verified backup of your OpenClaw state and configured plugin data before further repairs. Check installation access and disk space, then rerun openclaw doctor --fix; inspect retained evidence before restoring state.";
    warnings.push(`${message} ${fixHint}`);
    findings.push({
      checkId: "core/doctor/recovery-capture",
      severity: "warning",
      category: "fix-now",
      message,
      fixHint,
      docsUrl,
    });
  }
  return { findings, warnings };
}
