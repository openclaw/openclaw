import type { SessionEntry } from "./types.js";

/**
 * Common session status fields that multiple consumers extract from SessionEntry.
 * Adding a field here automatically propagates it to all consumer types and
 * extraction utilities (pickSessionStatus, applySessionStatusFields).
 *
 * model/modelProvider are intentionally excluded — each consumer resolves
 * them differently (resolveSessionModelRef, resolveModelSelection, or raw entry).
 */
export const SESSION_STATUS_FIELD_NAMES = [
  "systemSent",
  "abortedLastRun",
  "thinkingLevel",
  "verboseLevel",
  "reasoningLevel",
  "elevatedLevel",
  "responseUsage",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "totalTokensFresh",
  "contextTokens",
  "resolvedModel",
] as const;

export type SessionStatusFieldName = (typeof SESSION_STATUS_FIELD_NAMES)[number];
export type SessionStatusFields = Pick<SessionEntry, SessionStatusFieldName>;
/** Permissive variant that accepts null (e.g. from JSON-RPC deserialization). */
export type SessionStatusFieldsNullable = {
  [K in SessionStatusFieldName]?: SessionEntry[K] | null;
};

/**
 * Extract the common session status fields from a SessionEntry.
 * Skips undefined values so JSON.stringify output is unchanged.
 */
export function pickSessionStatus(
  entry: SessionEntry | null | undefined,
): Partial<SessionStatusFields> {
  if (!entry) {
    return {};
  }
  const result: Partial<SessionStatusFields> = {};
  for (const field of SESSION_STATUS_FIELD_NAMES) {
    const value = entry[field];
    if (value !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result as any)[field] = value;
    }
  }
  return result;
}

/**
 * Conditionally merge session status fields from source into target.
 * Only overwrites defined values — mirrors the pattern:
 *   if (source?.field !== undefined) target.field = source.field;
 * Accepts SessionStatusFieldsNullable so callers with JSON-RPC data (null values) work too.
 */
export function applySessionStatusFields(
  target: Partial<SessionStatusFieldsNullable>,
  source: Partial<SessionStatusFieldsNullable> | null | undefined,
): void {
  if (!source) {
    return;
  }
  for (const field of SESSION_STATUS_FIELD_NAMES) {
    const value = source[field];
    if (value !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (target as any)[field] = value;
    }
  }
}
