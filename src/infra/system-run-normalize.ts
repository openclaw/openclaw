import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { mapAllowFromEntries } from "openclaw/plugin-sdk/channel-config-helpers";

/** Normalizes unknown input to a trimmed non-empty string or null. */
export function normalizeNonEmptyString(value: unknown): string | null {
  return typeof value === "string" ? (normalizeOptionalString(value) ?? null) : null;
}

/** Normalizes unknown input to plugin-style string array entries. */
export function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? mapAllowFromEntries(value) : [];
}
