import { mapAllowFromEntries } from "openclaw/plugin-sdk/channel-config-helpers";

export function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? mapAllowFromEntries(value) : [];
}
