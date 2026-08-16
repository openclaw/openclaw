import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { SessionEntry } from "./types.js";

/** True when this entry's transcript began as a copy of a parent (actual forkSource ancestry or the legacy/thread-settled marker). */
export function sessionEntryForkedFromParent(
  entry: Pick<SessionEntry, "forkedFromParent" | "forkSource"> | undefined,
): boolean {
  return entry?.forkSource !== undefined || entry?.forkedFromParent === true;
}

/**
 * True when this entry's recorded lineage proves it continues `expectedSessionId`.
 * Only a same-key rollover stamps that lineage (see
 * `preserveSqliteSameKeySessionRolloverLineage`), so an explicit delete-then-recreate
 * under the same key records nothing and is reported as a replacement rather than a
 * successor: retrying a mutation against it would write to a session the caller never
 * named. `usageFamilySessionIds` carries the whole chain, so a second rollover still
 * resolves to the identity the caller started from.
 */
export function sessionEntryContinuesIdentity(
  entry: Pick<SessionEntry, "previousSessionId" | "usageFamilySessionIds"> | undefined,
  expectedSessionId: string | undefined,
): boolean {
  const expected = expectedSessionId?.trim();
  if (!entry || !expected) {
    return false;
  }
  return (
    entry.previousSessionId?.trim() === expected ||
    (entry.usageFamilySessionIds ?? []).some((sessionId) => sessionId.trim() === expected)
  );
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
