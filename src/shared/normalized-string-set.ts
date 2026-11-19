import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

/** Strict string-only lowercase lookup keys, in first-seen order. */
export function normalizeLowercaseStringSet(values: Iterable<unknown>): Set<string> {
  const normalized = new Set<string>();
  for (const value of values) {
    const key = normalizeOptionalLowercaseString(value);
    if (key) {
      normalized.add(key);
    }
  }
  return normalized;
}
