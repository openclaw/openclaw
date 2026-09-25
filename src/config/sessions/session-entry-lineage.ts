import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { SessionEntry } from "./types.js";

/** True when this entry's transcript began as a copy of a parent (actual forkSource ancestry or the legacy/thread-settled marker). */
export function sessionEntryForkedFromParent(
  entry: Pick<SessionEntry, "forkedFromParent" | "forkSource"> | undefined,
): boolean {
  return entry?.forkSource !== undefined || entry?.forkedFromParent === true;
}

export function preserveSqliteSameKeySessionRolloverLineage(params: {
  next: SessionEntry;
  previous: SessionEntry;
  sessionKey: string;
}): SessionEntry {
  const previousSessionId = params.previous.sessionId.trim();
  const nextSessionId = params.next.sessionId.trim();
  if (!previousSessionId || !nextSessionId || previousSessionId === nextSessionId) {
    return params.next;
  }
  return {
    ...params.next,
    previousSessionId,
    usageFamilyKey:
      params.next.usageFamilyKey ?? params.previous.usageFamilyKey ?? params.sessionKey,
    usageFamilySessionIds: uniqueStrings([
      ...(params.previous.usageFamilySessionIds ?? []),
      previousSessionId,
      ...(params.next.usageFamilySessionIds ?? []),
      nextSessionId,
    ]),
  };
}

/** Reset replaces execution state while retaining this logical session's saved delegation. */
export function preserveSessionResetLineage(entry: SessionEntry | undefined) {
  return {
    spawnedBy: entry?.spawnedBy,
    completionOwnerSessionKey: entry?.completionOwnerSessionKey,
    inheritedToolPolicyVersion: entry?.inheritedToolPolicyVersion,
    inheritedToolPolicy: entry?.inheritedToolPolicy,
    inheritedToolAllow: entry?.inheritedToolAllow,
    inheritedToolDeny: entry?.inheritedToolDeny,
    parentSessionKey: entry?.parentSessionKey,
    parentSessionId: entry?.parentSessionId,
    forkSource: entry?.forkSource,
    forkedFromParent: sessionEntryForkedFromParent(entry) ? true : undefined,
    spawnDepth: entry?.spawnDepth,
    subagentRole: entry?.subagentRole,
    subagentControlScope: entry?.subagentControlScope,
  };
}
