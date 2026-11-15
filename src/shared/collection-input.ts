import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

export { isStringArray } from "@openclaw/normalization-core/record-coerce";

export function normalizeOptionalTrimmedStringRecord(
  record: Record<string, unknown>,
): Record<string, string> | undefined {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    const entry = normalizeOptionalString(value);
    if (entry) {
      normalized[key] = entry;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}
