import { inspectSelfAndAncestorPidsSync } from "./restart-stale-pids.js";
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

// Ancestors are fixed when a process starts, so an identity-verified ancestor stays one
// for this process's lifetime. Keys carry the recorded start identity, and every check
// still re-verifies driver liveness, so a reused PID never matches a retained entry.
// Retaining the proof keeps a later transient process-inspection failure from
// revoking a continuation this process already verified.
const verifiedAncestorDrivers = new Set<string>();

function updateRunDriverKey(driver: UpdateRunDriver): string {
  return `${driver.host}\n${driver.pid}\n${driver.startIdentity}`;
}

type UpdateRunContinuationCheck = "continuation" | "not-continuation" | "ancestry-unverified";

/** Correlation alone cannot let another process continue a live update. */
function inspectCurrentUpdateRunContinuation(
  record: UpdateRunRecord,
  inheritedRunId: string | undefined,
): UpdateRunContinuationCheck {
  if (record.runId !== inheritedRunId?.trim() || hasUnrecordedUpdateRunDriver(record)) {
    return "not-continuation";
  }
  let ancestry: ReturnType<typeof inspectSelfAndAncestorPidsSync> | undefined;
  let ownsDriver = false;
  for (const driver of recordedUpdateRunDrivers(record)) {
    const liveness = inspectUpdateRunDriver(driver);
    if (liveness === "dead") {
      continue;
    }
    if (liveness !== "alive") {
      return "not-continuation";
    }
    const key = updateRunDriverKey(driver);
    if (!verifiedAncestorDrivers.has(key)) {
      ancestry ??= inspectSelfAndAncestorPidsSync(undefined, { requireVerifiedParent: true });
      if (!ancestry.complete) {
        return "ancestry-unverified";
      }
      if (!ancestry.pids.has(driver.pid)) {
        return "not-continuation";
      }
      verifiedAncestorDrivers.add(key);
    }
    ownsDriver = true;
  }
  return ownsDriver ? "continuation" : "not-continuation";
}

function formatUnverifiedUpdateRunAncestry(record: UpdateRunRecord): string {
  const pids = recordedUpdateRunDrivers(record)
    .map((driver) => driver.pid)
    .join(", ");
  return `Update ${record.runId} was inherited by this process, but this host could not read this process's ancestry to verify that its live driver (PID ${pids}) started it, so it was not treated as a continuation. This is a process-inspection failure, not evidence of another update. Retry when the host is less busy; if it persists, let the update finish, then run \`openclaw update repair\`.`;
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
    const check = inspectCurrentUpdateRunContinuation(run, inheritedRunId);
    if (check === "continuation") {
      continuation = run;
    } else if (!inspectUpdateRunDriverAbandonment(run, { explicit: true })) {
      // A captured continuation remains relevant after its driver terminalizes it.
      return {
        kind: "conflict",
        message:
          check === "ancestry-unverified"
            ? formatUnverifiedUpdateRunAncestry(run)
            : formatUpdateRunOwnership(run),
      };
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
