import { getSelfAndAncestorPidsSync } from "./restart-stale-pids.js";
import { inspectUpdateRunDriver, type UpdateRunDriver } from "./update-run-driver.js";
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

export function isStaleIdentitylessUpdateRun(record: UpdateRunRecord): boolean {
  return (
    record.status === "running" &&
    !record.origin.driver &&
    !record.origin.previousDrivers?.length &&
    Date.now() - updateRunLastActivity(record) > ABANDONED_UPDATE_RUN_MS
  );
}

export function recordedUpdateRunDrivers(record: UpdateRunRecord): UpdateRunDriver[] {
  return [
    ...(record.origin.driver ? [record.origin.driver] : []),
    ...(record.origin.previousDrivers ?? []),
  ];
}

/** Correlation alone cannot let another process continue a live update. */
function isCurrentUpdateRunContinuation(
  record: UpdateRunRecord,
  inheritedRunId: string | undefined,
): boolean {
  if (record.runId !== inheritedRunId?.trim() || hasUnrecordedUpdateRunDriver(record)) {
    return false;
  }
  const drivers = recordedUpdateRunDrivers(record);
  const ancestors = getSelfAndAncestorPidsSync(undefined, { requireVerifiedParent: true });
  let ownsDriver = false;
  for (const driver of drivers) {
    const liveness = inspectUpdateRunDriver(driver);
    if (liveness === "dead") {
      continue;
    }
    if (liveness !== "alive" || !ancestors.has(driver.pid)) {
      return false;
    }
    ownsDriver = true;
  }
  return ownsDriver;
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

export type UpdateRepairDriverAdmission =
  | { kind: "continuation"; run: UpdateRunRecord }
  | { kind: "recovery"; runs: UpdateRunRecord[] }
  | { kind: "conflict"; message: string };

export function inspectUpdateRepairDriverAdmission(
  runs: UpdateRunRecord[],
  inheritedRunId: string | undefined,
): UpdateRepairDriverAdmission {
  let continuation: UpdateRunRecord | undefined;
  for (const run of runs) {
    if (isCurrentUpdateRunContinuation(run, inheritedRunId)) {
      continuation = run;
    } else if (!inspectUpdateRunDriverAbandonment(run, { explicit: true })) {
      // A captured continuation remains relevant after its driver terminalizes it.
      return { kind: "conflict", message: formatUpdateRunOwnership(run) };
    }
  }
  return continuation ? { kind: "continuation", run: continuation } : { kind: "recovery", runs };
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

/** Recorded drivers require positive death evidence; untouched legacy admissions have a fixed expiry. */
export function inspectUpdateRunAbandonment(
  record: UpdateRunRecord,
  input: { explicit?: boolean } = {},
): string | undefined {
  return record.status === "running" ? inspectUpdateRunDriverAbandonment(record, input) : undefined;
}

function inspectUpdateRunDriverAbandonment(
  record: UpdateRunRecord,
  input: { explicit?: boolean },
): string | undefined {
  if (isExpiredLegacyUpdateRun(record)) {
    return LEGACY_UPDATE_RUN_EXPIRED_REASON;
  }
  const identityUnavailable = hasUnrecordedUpdateRunDriver(record);
  if (!input.explicit && identityUnavailable) {
    return undefined;
  }
  const drivers = recordedUpdateRunDrivers(record);
  // Explicit repair need not wait for dead drivers, but an unrecorded adopter may still be working.
  const requiresInactivity = !input.explicit || !drivers.length || identityUnavailable;
  if (requiresInactivity && Date.now() - updateRunLastActivity(record) <= ABANDONED_UPDATE_RUN_MS) {
    return undefined;
  }
  if (drivers.length) {
    return drivers.every((driver) => inspectUpdateRunDriver(driver) === "dead")
      ? "inactive-driver-dead"
      : undefined;
  }
  return input.explicit ? "operator-reconciled-inactive-run" : undefined;
}

/** Legacy activity cannot prove death; reporting must leave recovery to the operator. */
export function staleUpdateRunGuidance(record: UpdateRunRecord): string | undefined {
  return isStaleIdentitylessUpdateRun(record)
    ? `no activity since ${new Date(updateRunLastActivity(record)).toISOString()}; if no update is running, run \`openclaw update repair\` or start a new \`openclaw update\``
    : undefined;
}
