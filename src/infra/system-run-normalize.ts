export { normalizeNullableString as normalizeNonEmptyString } from "@openclaw/normalization-core/string-coerce";

/** Coerces array entries to allow-list strings while rejecting non-array inputs. */
export function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}
