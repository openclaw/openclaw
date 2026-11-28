import { inspectSelfAndAncestorPidsSync } from "./restart-stale-pids.js";
import {
  formatUpdateRunOwnership,
  inspectUpdateRunDriverAbandonment,
  isUpdateRunContinuationCandidate,
  recordedUpdateRunDrivers,
} from "./update-run-activity.js";
import { inspectUpdateRunDriver, type UpdateRunDriver } from "./update-run-driver.js";
import type { UpdateRunRecord } from "./update-run-record.js";

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
  if (!isUpdateRunContinuationCandidate(record, inheritedRunId)) {
    return "not-continuation";
  }
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
      // Containment ends at this driver; higher supervisors may be unreadable.
      const ancestry = inspectSelfAndAncestorPidsSync(undefined, {
        requireVerifiedParent: true,
        throughPid: driver.pid,
      });
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
  return `Update ${record.runId} was inherited by this process, but this host could not read this process's ancestry to verify that its live driver (PID ${pids}) started it, so it was not treated as a continuation. This is a process-inspection failure, not evidence of another update. Restore process inspection (on Linux, readable /proc/<pid>/stat or a compatible proc-safe native helper), wait for the recorded driver to exit, then run \`openclaw update repair\`.`;
}

export type UpdateRepairDriverAdmission =
  | { kind: "continuation"; run: UpdateRunRecord }
  | { kind: "recovery"; runs: UpdateRunRecord[] }
  | { kind: "conflict"; reason: "ancestry-unverified" | "driver-conflict"; message: string };

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
        reason: check === "ancestry-unverified" ? "ancestry-unverified" : "driver-conflict",
        message:
          check === "ancestry-unverified"
            ? formatUnverifiedUpdateRunAncestry(run)
            : formatUpdateRunOwnership(run),
      };
    }
  }
  return continuation ? { kind: "continuation", run: continuation } : { kind: "recovery", runs };
}
