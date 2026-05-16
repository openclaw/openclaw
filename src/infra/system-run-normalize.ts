import { mapAllowFromEntries } from "openclaw/plugin-sdk/channel-config-helpers";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export function normalizeNonEmptyString(value: unknown): string | null {
  return typeof value === "string" ? (normalizeOptionalString(value) ?? null) : null;
}

export function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? mapAllowFromEntries(value) : [];
}
