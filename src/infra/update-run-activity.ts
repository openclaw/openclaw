import {
  inspectUpdateRunDriver,
  sameUpdateRunDriver,
  toUpdateRunDriver,
  type UpdateRunDriver,
} from "./update-run-driver.js";
import {
  isExpiredLegacyUpdateRun,
  LEGACY_UPDATE_RUN_EXPIRED_REASON,
} from "./update-run-legacy-expiry.js";
import {
  isAbandonedUpdateRun,
  isAcknowledgedAbandonedUpdateRun,
  type UpdateRunRecord,
} from "./update-run-record.js";
import { ABANDONED_UPDATE_RUN_MS } from "./update-run-timeouts.js";

function updateRunLastActivity(record: UpdateRunRecord): number {
  return Math.max(
    record.updatedAtMs,
    ...record.steps.flatMap((step) => [step.startedAtMs ?? 0, step.endedAtMs ?? 0]),
  );
}

function hasUnrecordedUpdateRunDriver(record: UpdateRunRecord): boolean {
  return record.steps.some((step) => step.step === "driver:identity-unavailable");
}

export function isUpdateRunContinuationCandidate(
  record: UpdateRunRecord,
  inheritedRunId: string | undefined,
): boolean {
  return record.runId === inheritedRunId?.trim() && !hasUnrecordedUpdateRunDriver(record);
}

export function isStaleIdentitylessUpdateRun(record: UpdateRunRecord): boolean {
  return (
    record.status === "running" &&
    !record.origin.driver &&
    !record.origin.previousDrivers?.length &&
    Date.now() - updateRunLastActivity(record) > ABANDONED_UPDATE_RUN_MS
  );
}

/** Process identities only: callers copy them into strict lease and recovery records. */
export function recordedUpdateRunDrivers(record: UpdateRunRecord): UpdateRunDriver[] {
  return [
    ...(record.origin.driver ? [record.origin.driver] : []),
    ...(record.origin.previousDrivers ?? []),
  ].map(toUpdateRunDriver);
}

export function formatUpdateRunOwnership(record: UpdateRunRecord): string {
  const now = Date.now();
  const age = (at: number) => `${Math.max(0, Math.floor((now - at) / 1_000))}s`;
  const drivers = recordedUpdateRunDrivers(record);
  const owners = drivers.length
    ? drivers
        .map((driver) => {
          const observed = inspectUpdateRunDriver(driver);
          return `driver PID ${driver.pid} on ${driver.host}, liveness: ${observed === "unknown" ? "not observed" : observed}`;
        })
        .join("; ")
    : "driver PID and host not recorded, liveness: not observed";
  const activity = updateRunLastActivity(record);
  const unrecorded = hasUnrecordedUpdateRunDriver(record)
    ? "; unrecorded adopter: PID and host not recorded, liveness: not observed"
    : "";
  return `Update ${record.runId} remains recorded as running (${record.phase}); ${owners}${unrecorded}; started ${new Date(record.createdAtMs).toISOString()} (age ${age(record.createdAtMs)}), last activity ${new Date(activity).toISOString()} (age ${age(activity)}). Repair could not verify that the recorded update work stopped; it did not assume the update resumed. Check each named host or supervisor: this host cannot safely determine liveness when a driver is shown as "not observed". If a driver is active, wait for it or stop it through its owning host or supervisor. If this is the same machine after a rename, restore its recorded hostname before retrying \`openclaw update repair\`; otherwise contact support.`;
}

/** Only a fresh, unacknowledged recovery may substitute for a full repair invocation. */
export function isFreshUnacknowledgedAbandonedUpdateRun(record: UpdateRunRecord): boolean {
  return (
    isAbandonedUpdateRun(record) &&
    record.finishedAtMs !== null &&
    record.finishedAtMs <= Date.now() &&
    Date.now() - record.finishedAtMs <= ABANDONED_UPDATE_RUN_MS &&
    !isAcknowledgedAbandonedUpdateRun(record)
  );
}

/** Recorded drivers need death proof or exclusive repair custody; legacy admissions have a fixed expiry. */
export function inspectUpdateRunAbandonment(
  record: UpdateRunRecord,
  input: { explicit?: boolean; exclusiveRepair?: boolean } = {},
): string | undefined {
  return record.status === "running" ? inspectUpdateRunDriverAbandonment(record, input) : undefined;
}

export function inspectUpdateRunDriverAbandonment(
  record: UpdateRunRecord,
  input: { explicit?: boolean; exclusiveRepair?: boolean },
): string | undefined {
  if (isExpiredLegacyUpdateRun(record)) {
    return LEGACY_UPDATE_RUN_EXPIRED_REASON;
  }
  const identityUnavailable = hasUnrecordedUpdateRunDriver(record);
  if (!input.explicit && identityUnavailable) {
    return undefined;
  }
  let drivers = recordedUpdateRunDrivers(record);
  const handoff = record.origin.managedHandoff;
  if (handoff) {
    // The serving Gateway remains alive during validation, but no longer drives the update.
    // Adoption can prune the dead helper; its separate lifetime must still be checked.
    drivers = [
      handoff.helper,
      ...drivers.filter(
        (driver) =>
          !sameUpdateRunDriver(driver, handoff.parent) &&
          !sameUpdateRunDriver(driver, handoff.helper),
      ),
    ];
  }
  // Confirmed driver death needs no grace; an unrecorded adopter may still be working.
  const requiresInactivity = !drivers.length || identityUnavailable;
  if (requiresInactivity && Date.now() - updateRunLastActivity(record) <= ABANDONED_UPDATE_RUN_MS) {
    return undefined;
  }
  if (drivers.length) {
    if (drivers.every((driver) => inspectUpdateRunDriver(driver) === "dead")) {
      return handoff ? "handoff-terminated" : "inactive-driver-dead";
    }
    // Repair's live executor and state custody exclude these drivers even after
    // a machine rename. Elapsed time or a foreign hostname alone cannot do so.
    if (
      input.exclusiveRepair &&
      !identityUnavailable &&
      drivers.every((driver) => inspectUpdateRunDriver(driver) !== "alive")
    ) {
      return "exclusive-repair-ownership";
    }
    return undefined;
  }
  return input.explicit ? "operator-reconciled-inactive-run" : undefined;
}

/** Legacy activity cannot prove death; reporting must leave recovery to the operator. */
export function staleUpdateRunGuidance(record: UpdateRunRecord): string | undefined {
  return isStaleIdentitylessUpdateRun(record)
    ? `no activity since ${new Date(updateRunLastActivity(record)).toISOString()}; if no update is running, run \`openclaw update repair\` or start a new \`openclaw update\``
    : undefined;
}

const POST_CORE_PHASES = new Set(["activating", "restarting", "verifying"]);

export function needsPostCoreRepair(run: UpdateRunRecord): boolean {
  // Reconciliation finishes phase steps but does not prove post-core convergence.
  return (
    POST_CORE_PHASES.has(run.phase) ||
    run.steps.some(
      (step) =>
        POST_CORE_PHASES.has(step.step) ||
        step.step === "post-update verification" ||
        step.step.startsWith("finalize:"),
    )
  );
}

export function inspectNewerRecoveryHistory(
  oldestRecovery: number | undefined,
  history: UpdateRunRecord[],
) {
  if (oldestRecovery === undefined) {
    return { postCoreRuns: [], incomplete: false };
  }
  const postCoreRuns = history.filter(
    (run) =>
      run.createdAtMs >= oldestRecovery &&
      run.status === "failed" &&
      !isAcknowledgedAbandonedUpdateRun(run) &&
      needsPostCoreRepair(run),
  );
  // A bounded prefix cannot prove absence of interrupted work beyond its tail.
  const incomplete = history.length === 100 && (history.at(-1)?.createdAtMs ?? 0) >= oldestRecovery;
  return { postCoreRuns, incomplete };
}
