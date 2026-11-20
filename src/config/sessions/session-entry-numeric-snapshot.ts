import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { SessionStoreMigrationRequiredError } from "./migration-required.js";
import type { SessionEntry } from "./types.js";

// Snooze deadlines, version discriminants, and projected participant counts have their own owners.
export const SESSION_ENTRY_NUMERIC_FIELDS = [
  "lastHeartbeatSentAt",
  "archivedAt",
  "pinnedAt",
  "snoozedAt",
  "lastReadAt",
  "markedUnreadAt",
  "lastActivityAt",
  "createdAt",
  "spawnDepth",
  "sessionStartedAt",
  "lastInteractionAt",
  "startedAt",
  "endedAt",
  "runtimeMs",
  "abortCutoffTimestamp",
  "lastTtsReadLatestAt",
  "authProfileOverrideCompactionCount",
  "queueDebounceMs",
  "queueCap",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "estimatedCostUsd",
  "cacheRead",
  "cacheWrite",
  "contextTokens",
  "compactionCount",
] as const satisfies readonly (keyof SessionEntry)[];

type OptionalNumericField = (typeof SESSION_ENTRY_NUMERIC_FIELDS)[number];
export type SessionEntryNumericSnapshot = Pick<SessionEntry, OptionalNumericField>;

/** Admit canonical numeric metadata once, before consumers perform arithmetic on it. */
export function projectSessionEntryNumericSnapshot(value: {
  [Field in OptionalNumericField]?: unknown;
}): SessionEntryNumericSnapshot {
  const snapshot: SessionEntryNumericSnapshot = {};
  for (const field of SESSION_ENTRY_NUMERIC_FIELDS) {
    if (!Object.hasOwn(value, field)) {
      continue;
    }
    const candidate = value[field];
    const number = asFiniteNumber(candidate);
    if (candidate !== undefined && number === undefined) {
      throw new SessionStoreMigrationRequiredError(
        `Session field "${field}" must be a finite number; stop the Gateway and run openclaw doctor --fix to repair legacy numeric strings. Unusable values require offline repair or restoration.`,
      );
    }
    snapshot[field] = number;
  }
  return snapshot;
}
