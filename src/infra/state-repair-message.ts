export function formatDoctorStateRepairFailure(problem: string, recovery: string): string {
  return `Doctor cannot repair this state: ${problem}. ${recovery}`;
}

/** Shared diagnosis for an unreadable state database; callers own the operation prefix. */
export function describeUnreadableStateDatabase(
  path: string,
  reason: string,
): { problem: string; recovery: string } {
  return {
    problem: `shared state database is unreadable at ${path}: ${reason}`,
    recovery:
      "Stop OpenClaw processes, then restore this file from a verified backup; the unreadable database was left unchanged.",
  };
}

export class DoctorUnreadableStateDatabaseError extends Error {
  constructor(path: string, reason: string) {
    const { problem, recovery } = describeUnreadableStateDatabase(path, reason);
    super(formatDoctorStateRepairFailure(problem, recovery));
    this.name = "DoctorUnreadableStateDatabaseError";
  }
}
