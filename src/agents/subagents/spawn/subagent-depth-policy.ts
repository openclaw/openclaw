import { isParentOwnedBackgroundAcpSession } from "@openclaw/acp-core/session-interaction-mode";
import { parseStrictNonNegativeInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { getSubagentDepth } from "../../../sessions/session-key-utils.js";

type PersistedSessionDepthEntry = Pick<SessionEntry, "sessionId" | "spawnDepth" | "spawnedBy">;
export type SessionDepthEntry = { [Key in keyof PersistedSessionDepthEntry]?: unknown };

function normalizeSpawnDepth(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value === "string") {
    return parseStrictNonNegativeInteger(value);
  }
  return undefined;
}

export function getSubagentDepthFromEntryLookup(
  sessionKey: string | undefined | null,
  resolveEntry: (sessionKey: string) => SessionDepthEntry | undefined,
): number {
  const raw = (sessionKey ?? "").trim();
  const fallbackDepth = getSubagentDepth(raw);
  if (!raw) {
    return fallbackDepth;
  }

  const visited = new Set<string>();

  const depthFromStore = (key: string): number | undefined => {
    const normalizedKey = normalizeOptionalString(key);
    if (!normalizedKey) {
      return undefined;
    }
    if (visited.has(normalizedKey)) {
      return undefined;
    }
    visited.add(normalizedKey);

    const entry = resolveEntry(normalizedKey);
    const storedDepth = normalizeSpawnDepth(entry?.spawnDepth);
    if (storedDepth !== undefined) {
      return storedDepth;
    }

    // parentSessionKey also links operator UI threads; only spawnedBy carries lineage.
    const parentKey = normalizeOptionalString(entry?.spawnedBy);
    if (!parentKey) {
      return undefined;
    }

    const parentDepth = depthFromStore(parentKey);
    if (parentDepth !== undefined) {
      return parentDepth + 1;
    }

    return getSubagentDepth(parentKey) + 1;
  };

  return depthFromStore(raw) ?? fallbackDepth;
}

/** Classifies coordination from the exact session entry and its canonical ACP metadata. */
export function isSubagentSessionFromEntry(
  sessionKey: string,
  entry: SessionEntry | null | undefined,
  acpMeta?: unknown,
): boolean {
  const spawnDepth = normalizeSpawnDepth(entry?.spawnDepth);
  return (
    (spawnDepth === undefined
      ? Boolean(normalizeOptionalString(entry?.spawnedBy)) || getSubagentDepth(sessionKey) > 0
      : spawnDepth > 0) ||
    isParentOwnedBackgroundAcpSession(entry ? { ...entry, acp: acpMeta } : entry)
  );
}
