import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/** Normalizes unknown system-run metadata to a trimmed non-empty string. */
export function normalizeNonEmptyString(value: unknown): string | null {
  return typeof value === "string" ? (normalizeOptionalString(value) ?? null) : null;
}

/** Coerces array entries to allow-list strings while rejecting non-array inputs. */
export function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}
