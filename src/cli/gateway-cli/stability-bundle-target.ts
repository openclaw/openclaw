import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

export function normalizeStabilityBundleTarget(raw: unknown): string | null {
  if (raw === undefined || raw === false) {
    return null;
  }
  const value = normalizeOptionalString(raw);
  if (typeof raw === "string" && value === undefined) {
    throw new Error('--bundle must be a non-empty path or "latest".');
  }
  return value ?? "latest";
}
