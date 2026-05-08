import type { SessionEntry } from "./types.js";

/**
 * Broad check: is the value a non-null, non-array object?
 */
export function isSessionStoreRecord(
  value: unknown,
): value is Record<string, SessionEntry> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Stricter check: does this value look like a real session entry?
 * Requires sessionId to be a non-empty string.
 */
export function isValidSessionEntry(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return typeof entry.sessionId === "string" && entry.sessionId.length > 0;
}

/**
 * Check if a parsed JSON object contains at least one valid session entry.
 */
export function hasValidSessionEntries(parsed: unknown): boolean {
  if (!isSessionStoreRecord(parsed)) {
    return false;
  }
  for (const key of Object.keys(parsed)) {
    if (isValidSessionEntry(parsed[key])) {
      return true;
    }
  }
  return false;
}
