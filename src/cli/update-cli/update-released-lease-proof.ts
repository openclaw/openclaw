import fs from "node:fs";
import { formatErrorMessage } from "../../infra/errors.js";
import { readPackageVersion } from "../../infra/package-json.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import type { PluginCohortRecoveryPair } from "../../infra/update-plugin-cohort-schema.js";
import {
  hasUnrecordedUpdateRunDriver,
  recordedUpdateRunDrivers,
} from "../../infra/update-run-activity.js";
import { inspectUpdateRunDriver } from "../../infra/update-run-driver.js";
import { recordUpdateRunVerification } from "../../infra/update-run-ledger.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { defaultRuntime } from "../../runtime.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db-contract.js";
import { INTERRUPTED_UPDATE_SETTLE_TIMEOUT_MS } from "../daemon-cli/restart-health.constants.js";

// An update whose driver unwound released its own lease, so the update lease store no
// longer holds it. These are the facts that let the next update settle that update
// anyway, and only forward onto the candidate it installed.

export const UNLEASED_REFUSAL =
  "The update lease store no longer holds that update's lease, so this update cannot show that its processes are gone.";

/**
 * An executor's lease row is deleted only while its store records none of that
 * executor's children unsettled: by the executor's own unwind, or by a later claim
 * that reclaimed it after the executor died. A store without an update's lease
 * therefore shows that update's processes gone when it is the file that held the
 * lease, one created before the run began. A store created since, as after a
 * temporary-directory cleanup, recorded nothing of them. A host that cannot report
 * a creation time reports zero or, on older Linux, the change time; neither shows it.
 */
function leaseStorePredatesRun(databasePath: string, run: UpdateRunRecord): boolean {
  try {
    const { birthtimeMs, ctimeMs } = fs.statSync(databasePath);
    return birthtimeMs > 0 && birthtimeMs !== ctimeMs && birthtimeMs < run.createdAtMs;
  } catch {
    return false;
  }
}

/**
 * Without its lease, an update's store proof only stands for settling forward: the
 * run recorded its candidate serving, that exact build is the installed core, and
 * every process it recorded has exited. Rollback is repair's.
 */
export async function inspectReleasedLeaseProof(
  pair: PluginCohortRecoveryPair,
  run: UpdateRunRecord,
  root: string,
  databasePath: string | undefined,
): Promise<boolean> {
  const { from, to } = pair.reservation;
  const drivers = recordedUpdateRunDrivers(run);
  const { verification } = run;
  if (
    !databasePath ||
    to.buildId === null ||
    (from.version === to.version && from.buildId === to.buildId) ||
    pair.cohort.disposition === "rollback" ||
    run.origin.managedHandoff ||
    hasUnrecordedUpdateRunDriver(run) ||
    !drivers.length ||
    drivers.some((driver) => inspectUpdateRunDriver(driver) !== "dead") ||
    verification.serviceRunning !== true ||
    verification.versionMatch !== true ||
    verification.runningVersion !== to.version ||
    verification.runningBuildId !== to.buildId ||
    !leaseStorePredatesRun(databasePath, run)
  ) {
    return false;
  }
  const [version, buildId] = await Promise.all([
    readPackageVersion(root),
    readBuiltGatewayBuildId(root),
  ]);
  return version === to.version && buildId === to.buildId;
}

/**
 * Under the installation claim: the same proof again, then a fresh probe of the
 * managed Gateway, because the run's recorded verification describes that update
 * and not what serves now. Returns the probe's verification, or the refusal.
 */
export async function confirmReleasedLeaseProof(
  pair: PluginCohortRecoveryPair,
  run: UpdateRunRecord,
  root: string,
  databasePath: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<{ verification: UpdateRunRecord["verification"] } | { refusal: string }> {
  const { version, buildId } = pair.reservation.to;
  if (buildId === null || !(await inspectReleasedLeaseProof(pair, run, root, databasePath))) {
    return { refusal: UNLEASED_REFUSAL };
  }
  const [
    { createGatewayRestartDeadline, GatewayRestartDeadlineError },
    { observeInterruptedUpdateGateway },
  ] = await Promise.all([
    import("../daemon-cli/restart-health-deadline.js"),
    import("../../infra/update-run-interruption-health.js"),
  ]);
  const deadline = createGatewayRestartDeadline({
    timeoutMs: INTERRUPTED_UPDATE_SETTLE_TIMEOUT_MS,
  });
  let why: string;
  try {
    const observed = await deadline.run(() =>
      observeInterruptedUpdateGateway({ version, buildId }, { env, deadline, root }),
    );
    // Probe commands whose cleanup is not confirmed may still be running.
    const cleanup = deadline.cleanupStatus;
    if (
      observed.outcome === "settled" &&
      observed.verification &&
      cleanup !== "pending" &&
      cleanup !== "unknown"
    ) {
      return { verification: observed.verification };
    }
    why = `${observed.outcome} during ${observed.phase}`;
  } catch (error) {
    why =
      error instanceof GatewayRestartDeadlineError
        ? `timed-out during ${deadline.expiredPhase ?? deadline.phase}`
        : formatErrorMessage(error);
  } finally {
    deadline.dispose();
  }
  return {
    refusal: `Its updater released its lease after verifying OpenClaw ${version}, but the managed Gateway is not serving OpenClaw ${version} (build ${buildId}) now (${why}), so this update does not settle it.`,
  };
}

/** Settlement admission for that update: only keeping its candidate stands on the proof. */
export function admitsReleasedLeaseSettlement(plan: {
  action: "commit" | "rollback";
  originalCore: boolean;
  candidateCore: boolean;
  packageRecoveryAuthority: boolean;
  rollbackStarted: boolean;
}): boolean {
  return (
    plan.action === "commit" &&
    !plan.rollbackStarted &&
    !plan.originalCore &&
    plan.candidateCore &&
    !plan.packageRecoveryAuthority
  );
}

/**
 * After settlement, the probe goes on the run, so history reconciliation closes it as
 * succeeded, as it closes one whose driver was lost after a booted Gateway verified
 * its candidate. A failed write leaves the run to close as abandoned, as repair does.
 */
export function recordReleasedLeaseVerification(
  runId: string,
  verification: UpdateRunRecord["verification"],
  options: OpenClawStateDatabaseOptions & { busyTimeoutMs?: number },
): void {
  try {
    recordUpdateRunVerification(runId, verification, { ...options, onlyIfRunning: true });
  } catch (error) {
    defaultRuntime.error(
      `Warning: The verified serving candidate was not recorded in update history: ${String(error)}`,
    );
  }
}
