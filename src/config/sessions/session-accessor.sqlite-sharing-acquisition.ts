import type { SessionRowFacts } from "../../sessions/session-row-changes.js";
import type {
  SessionEntryPlaceholder,
  SessionSharingEntry,
} from "./session-accessor.sqlite-entry-cache.types.js";

export type CommittedSessionSharingFacts = {
  entry: SessionSharingEntry | undefined;
  placeholder?: SessionEntryPlaceholder;
  membership: ReadonlySet<string>;
};

export type SessionSharingAcquisition = {
  invalidated: boolean;
  entry?: SessionSharingEntry;
  sessionId?: string;
  membership: Map<string, boolean>;
};

export type PreparedSessionSharingRead = {
  pending: Set<object>;
  facts: CommittedSessionSharingFacts | undefined;
  acquisition?: SessionSharingAcquisition;
  generation?: {
    initiallyAbsent?: true;
    current: Pick<SessionSharingEntry, "sessionId" | "lifecycleRevision"> | null | undefined;
  };
};

export type SessionSharingRetentionRequest = {
  databaseIdentity: string;
  sessionKey: string;
} & (
  | { acquiring: true }
  | (CommittedSessionSharingFacts & { generation?: PreparedSessionSharingRead["generation"] })
);

export function publishRetainedSessionGeneration(
  read: PreparedSessionSharingRead,
  entry: SessionSharingEntry | undefined,
  known: boolean,
) {
  const generation = read.generation;
  if (generation?.initiallyAbsent) {
    // An appearance revokes an absence lease even if a later write deletes the row again.
    if (generation.current === null) {
      generation.current = known ? (entry ?? null) : undefined;
    }
    return;
  }
  if (!generation?.current) {
    return;
  }
  if (!known) {
    generation.current = undefined;
  } else if (
    !entry ||
    generation.current.sessionId !== entry.sessionId ||
    generation.current.lifecycleRevision !== entry.lifecycleRevision
  ) {
    generation.current = null;
  }
}

/** Reconcile one worker snapshot with commit postimages, without adopting another lifecycle. */
export function reconcileSessionSharingAcquisition(
  acquisition: SessionSharingAcquisition,
  snapshot: CommittedSessionSharingFacts,
): CommittedSessionSharingFacts {
  if (
    acquisition.invalidated ||
    (acquisition.sessionId !== undefined && acquisition.sessionId !== snapshot.entry?.sessionId) ||
    (acquisition.entry !== undefined &&
      acquisition.entry.lifecycleRevision !== snapshot.entry?.lifecycleRevision)
  ) {
    throw new Error("Session sharing acquisition is no longer current");
  }
  const membership = new Set(snapshot.membership);
  for (const [identityId, present] of acquisition.membership) {
    if (present) {
      membership.add(identityId);
    } else {
      membership.delete(identityId);
    }
  }
  return { ...snapshot, entry: acquisition.entry ?? snapshot.entry, membership };
}

/** The committing producer supplies both identities; a matching final snapshot cannot undo reset. */
export function recordAcquiringSessionEntry(
  acquisition: SessionSharingAcquisition | undefined,
  entry: SessionSharingEntry | undefined,
  previous: Pick<SessionSharingEntry, "sessionId" | "lifecycleRevision"> | undefined,
): void {
  if (!acquisition) {
    return;
  }
  if (
    !entry ||
    !previous ||
    previous.sessionId !== entry.sessionId ||
    previous.lifecycleRevision !== entry.lifecycleRevision ||
    (acquisition.sessionId !== undefined && acquisition.sessionId !== entry.sessionId) ||
    (acquisition.entry !== undefined &&
      acquisition.entry.lifecycleRevision !== entry.lifecycleRevision)
  ) {
    acquisition.invalidated = true;
    return;
  }
  acquisition.entry = entry;
  acquisition.sessionId = entry.sessionId;
}

export function recordAcquiringSessionMember(
  acquisition: SessionSharingAcquisition,
  member: Extract<SessionRowFacts, { kind: "member" }>,
): void {
  if (acquisition.sessionId !== undefined && acquisition.sessionId !== member.sessionId) {
    acquisition.invalidated = true;
  }
  acquisition.sessionId = member.sessionId;
  acquisition.membership.set(member.identityId, member.present);
}

/** Apply a committed field postimage only to its original session generation. */
export function updateSessionSharingField(
  facts: CommittedSessionSharingFacts,
  change: Extract<SessionRowFacts, { kind: "member" | "owner" }>,
): CommittedSessionSharingFacts {
  if (facts.entry?.sessionId !== change.sessionId) {
    return facts;
  }
  if (change.kind === "owner") {
    return (facts.entry.lifecycleRevision ?? null) === change.lifecycleRevision
      ? { ...facts, entry: { ...facts.entry, owner: change.owner } }
      : facts;
  }
  const membership = new Set(facts.membership);
  if (change.present) {
    membership.add(change.identityId);
  } else {
    membership.delete(change.identityId);
  }
  return { ...facts, membership };
}
