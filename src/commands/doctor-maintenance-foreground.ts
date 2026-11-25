import { TICK_INTERVAL_MS } from "../gateway/server-constants.js";
import { acquireWithWait } from "../infra/acquire-with-wait.js";
import { acquireGatewayLock, GatewayLockError } from "../infra/gateway-lock.js";
import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "../infra/gateway-shutdown-budget.js";
import { GatewayStateOwnerContentionError } from "../infra/gateway-state-owner.js";
import { resolveGatewayRestartDeferralTimeoutMs } from "../infra/restart-budget.js";
import { DEFAULT_UPDATE_STEP_TIMEOUT_MS } from "../infra/update-run-timeouts.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import type { RuntimeEnv } from "../runtime.js";
import { sleep } from "../utils/sleep.js";
import type { DoctorOptions } from "./doctor-prompter.js";
import { isDoctorUpdateRepairMode, resolveDoctorRepairMode } from "./doctor-repair-mode.js";

// Twice the slowest measured update Doctor (258 s: 60 agents, 1 CPU, 10 MB/s disk), rounded up.
const DOCTOR_WORK_RESERVE_FLOOR_MS = 10 * 60_000;
export const DOCTOR_MAINTENANCE_WAIT_PROGRESS_INTERVAL_MS = 30_000;

/**
 * The time, on this process's `performance.now()` clock, when update Doctor stops
 * waiting for other OpenClaw processes. Published drivers bound activation Doctor
 * only by an operator `--timeout`, counted from its spawn and not passed on, so
 * Doctor stays within the default step allowance from its own start. It keeps
 * twice this update's rehearsal Doctor time, and at least the floor, for its own
 * work. Every wait in one Doctor process ends at this deadline, so earlier waits
 * shorten later ones.
 */
export async function resolveDoctorMaintenanceWaitDeadlineMs(
  env: NodeJS.ProcessEnv,
): Promise<number> {
  let rehearsalMs = 0;
  try {
    const { findActiveUpdateRun } = await import("../infra/update-run-reader.js");
    const step = findActiveUpdateRun({ env })?.steps.findLast(
      (entry) => entry.step === "candidate-doctor",
    );
    if (step?.startedAtMs !== undefined && step.endedAtMs !== undefined) {
      rehearsalMs = Math.max(0, step.endedAtMs - step.startedAtMs);
    }
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    // An unreadable ledger is a missing measurement; the floor still applies.
  }
  return DEFAULT_UPDATE_STEP_TIMEOUT_MS - Math.max(DOCTOR_WORK_RESERVE_FLOOR_MS, 2 * rehearsalMs);
}

export function formatDoctorWaitSeconds(ms: number) {
  return `${Math.max(0, Math.round(ms / 1000))} s`;
}

function describeHolder(error: GatewayStateOwnerContentionError) {
  const { holder } = error;
  return `the OpenClaw ${holder?.role ? `${holder.role} ` : ""}process ${holder?.pid ?? "(unknown PID)"}`;
}

/**
 * Another process with a recorded non-Gateway role finishes on its own. This
 * process's own owner cannot release while Doctor waits on it, and an unknown or
 * Gateway holder keeps the existing serving-owner decisions.
 */
function isTransientHolder(error: unknown): error is GatewayStateOwnerContentionError {
  const holder = error instanceof GatewayStateOwnerContentionError ? error.holder : undefined;
  return (
    holder?.role !== undefined &&
    holder.role !== "gateway" &&
    holder.pid !== undefined &&
    holder.pid !== process.pid
  );
}

export async function acquireDoctorGatewayMaintenanceOwner(
  databasePath: string,
  env: NodeJS.ProcessEnv,
  params: {
    options: DoctorOptions;
    waitForMaintenance?: boolean;
    runtime: RuntimeEnv;
    assertCurrent?: () => void;
    assertAdmission?: () => void;
    deadlineMs?: number;
    signal?: AbortSignal;
  },
) {
  const updateRepair = isDoctorUpdateRepairMode(resolveDoctorRepairMode(params.options, env));
  const waitForMaintenance = updateRepair || params.waitForMaintenance === true;
  const assertCurrent =
    params.assertCurrent || params.assertAdmission
      ? () => {
          params.assertCurrent?.();
          params.assertAdmission?.();
        }
      : undefined;
  const startedAt = performance.now();
  // Installation replacement is an unsupervised restart: detection, drain,
  // then server close and process exit each retain their owner's allowance.
  const gatewayDeadlineMs = Math.min(
    params.deadlineMs ?? Infinity,
    startedAt +
      TICK_INTERVAL_MS +
      resolveGatewayRestartDeferralTimeoutMs() +
      GATEWAY_SERVICE_STOP_TIMEOUT_MS,
  );
  // A transient holder is not bounded by any service stop: nothing Doctor stopped
  // waits on it, and waiting holds no lock. Resolved on the first such holder.
  let transientDeadlineMs: number | undefined;
  let waiting: "gateway" | "transient" | undefined;
  let lastContention: GatewayStateOwnerContentionError | undefined;
  let nextProgressAt = 0;
  let pollMs = 100;
  const pollUntil = (deadlineMs: number, now: number) => {
    const delayMs = Math.min(pollMs, deadlineMs - now);
    pollMs = Math.min(pollMs * 2, 1_000);
    return { delayMs };
  };
  const acquire = async () => {
    try {
      const owner = await acquireGatewayLock({
        env,
        role: "sqlite-maintenance",
        allowInTests: true,
        lifecycleDeadlineMs: params.deadlineMs,
        assertCurrent,
        onWait: params.runtime.log,
      });
      if (!owner) {
        throw new Error(`Doctor could not acquire maintenance ownership for ${databasePath}`);
      }
      return owner;
    } catch (error) {
      if (
        error instanceof GatewayLockError &&
        error.cause instanceof GatewayStateOwnerContentionError
      ) {
        if (waitForMaintenance && isTransientHolder(error.cause)) {
          transientDeadlineMs ??= await resolveDoctorMaintenanceWaitDeadlineMs(env);
        }
        throw error.cause;
      }
      throw error;
    }
  };
  try {
    const owner = await acquireWithWait({
      acquire,
      shouldRetry: (error) => {
        if (!waitForMaintenance || !(error instanceof GatewayStateOwnerContentionError)) {
          return false;
        }
        params.signal?.throwIfAborted();
        assertCurrent?.();
        const now = performance.now();
        if (transientDeadlineMs !== undefined && isTransientHolder(error)) {
          lastContention = error;
          if (now >= transientDeadlineMs) {
            return false;
          }
          if (waiting !== "transient" || now >= nextProgressAt) {
            params.runtime.log(
              waiting === "transient"
                ? `Still waiting for ${describeHolder(error)} to release ${error.databasePath} (${formatDoctorWaitSeconds(now - startedAt)} of ${formatDoctorWaitSeconds(transientDeadlineMs - startedAt)}).`
                : `Waiting up to ${formatDoctorWaitSeconds(transientDeadlineMs - now)} for ${describeHolder(error)} to release ${error.databasePath} before Doctor maintenance. Let it finish, or stop it to continue sooner.`,
            );
            nextProgressAt = now + DOCTOR_MAINTENANCE_WAIT_PROGRESS_INTERVAL_MS;
          }
          waiting = "transient";
          return pollUntil(transientDeadlineMs, now);
        }
        // A delegated updater may reach Doctor before its replaced foreground
        // Gateway observes the new installation and finishes releasing state.
        // A deadline-only check cannot authorize waiting for a delegated Gateway exit.
        if (!params.assertCurrent || now >= gatewayDeadlineMs) {
          return false;
        }
        if (waiting !== "gateway") {
          waiting = "gateway";
          params.runtime.log("Waiting for the previous foreground Gateway to release state.");
        }
        // The physical lock decides ownership. A replacement owner may make us
        // wait until the same bounded deadline, but cannot grant unsafe access.
        return pollUntil(gatewayDeadlineMs, now);
      },
      // Each holder kind ends at its own deadline above.
      deadlineMs: Infinity,
      pollIntervalMs: 100,
      sleep: (ms) => sleep(ms, params.signal),
    });
    if (waiting === "transient") {
      params.runtime.log(
        `State ownership released after ${formatDoctorWaitSeconds(performance.now() - startedAt)}; continuing Doctor maintenance.`,
      );
    }
    return owner;
  } catch (error) {
    // Only the contention that ended the wait gains its wait detail.
    if (error === lastContention && error instanceof GatewayStateOwnerContentionError) {
      // Keep the contention class: admission still classifies it as deferred.
      throw new GatewayStateOwnerContentionError(
        error.databasePath,
        error,
        `Doctor waited ${formatDoctorWaitSeconds(performance.now() - startedAt)} for ${describeHolder(error)} to finish; ${error.holderDetail ?? "it is still running."}`,
        error.holder,
      );
    }
    throw error;
  }
}
