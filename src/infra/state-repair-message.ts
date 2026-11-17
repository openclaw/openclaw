import { isSqliteSnapshotCapacityError } from "./sqlite-snapshot-capacity-error.js";

export function formatDoctorStateRepairFailure(problem: string, recovery: string): string {
  return `Doctor cannot repair this state: ${problem}. ${recovery}`;
}

/** Shared diagnosis for an unreadable state database; callers own the operation prefix. */
export function describeUnreadableStateDatabase(
  path: string,
  reason: string,
  options?: ErrorOptions,
): { problem: string; recovery: string } {
  if (isSqliteSnapshotCapacityError(options?.cause)) {
    return {
      problem: `shared state database inspection is unavailable at ${path}: ${reason}`,
      recovery: "Free snapshot disk space or quota, then retry the inspection.",
    };
  }
  return {
    problem: `shared state database is unreadable at ${path}: ${reason}`,
    recovery:
      "Stop OpenClaw processes, then restore this file from a verified backup; the unreadable database was left unchanged.",
  };
}

export class DoctorUnreadableStateDatabaseError extends Error {
  constructor(path: string, reason: string, options?: ErrorOptions) {
    const { problem, recovery } = describeUnreadableStateDatabase(path, reason, options);
    super(formatDoctorStateRepairFailure(problem, recovery), options);
    this.name = "DoctorUnreadableStateDatabaseError";
  }
}
