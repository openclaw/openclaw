/** Resolve the portion of a parent Doctor deadline available to one nested service call. */
export function resolveRemainingDoctorServiceInspectionTimeoutMs(
  deadlineAtMs: number | undefined,
  now = Date.now(),
): number | undefined {
  if (deadlineAtMs === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(deadlineAtMs)) {
    throw new Error("Doctor service-inspection deadline is invalid.");
  }
  const remainingMs = deadlineAtMs - now;
  if (remainingMs <= 0) {
    throw new Error("Doctor service-inspection deadline has expired.");
  }
  return remainingMs;
}
