/** Normalize gateway stability --bundle option values. */
export function normalizeStabilityBundleTarget(raw: unknown): string | null {
  if (raw === undefined || raw === false) {
    return null;
  }
  if (raw === true) {
    return "latest";
  }
  if (typeof raw !== "string") {
    return "latest";
  }
  const value = raw.trim();
  if (value === "") {
    throw new Error('--bundle must be a non-empty path or "latest".');
  }
  return value;
}
