/** Translate a handoff timestamp once; wall-clock corrections cannot replenish Doctor work. */
export function createDoctorServiceInspectionBudget(deadlineAtMs: number | undefined) {
  const deadline =
    deadlineAtMs === undefined ? undefined : performance.now() + deadlineAtMs - Date.now();
  return (): number | undefined => {
    if (deadline === undefined) {
      return undefined;
    }
    const remainingMs = Math.ceil(deadline - performance.now());
    if (remainingMs <= 0) {
      throw new Error("Doctor service-inspection deadline has expired.");
    }
    return remainingMs;
  };
}
