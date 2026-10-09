import type { SessionRowFacts } from "../../sessions/session-row-changes.js";
import type {
  SessionEntryPlaceholder,
  SessionSharingEntry,
} from "./session-accessor.sqlite-entry-cache.types.js";
import type { SessionEntry } from "./types.js";

export type PreparedSessionEntryPredicate = {
  entry: SessionEntry | undefined;
  matches: (entry: SessionEntry | undefined) => boolean;
  state: "current" | "unknown" | "changed";
  revision: number;
  pending: Set<object>;
};

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
  predicate?: PreparedSessionEntryPredicate;
  pending: Set<object>;
  facts: CommittedSessionSharingFacts | undefined;
  acquisition?: SessionSharingAcquisition;
  generation?: {
    initiallyAbsent?: true;
    current:
      | Pick<
          SessionSharingEntry,
          "sessionId" | "lifecycleRevision" | "permissionMode" | "toolOverrides"
        >
      | null
      | undefined;
  };
};

export type SessionSharingRetentionRequest = {
  databaseIdentity: string;
  sessionKey: string;
  predicate?: PreparedSessionEntryPredicate;
} & (
  | { acquiring: true }
  | (CommittedSessionSharingFacts & { generation?: PreparedSessionSharingRead["generation"] })
);

/** Unknown postimages require a fresh read; observed mismatches cannot be restored. */
export function publishRetainedSessionEntryPredicate(
  read: PreparedSessionSharingRead,
  entry: SessionEntry | undefined,
  known: boolean,
): void {
  const predicate = read.predicate;
  if (!predicate) {
    return;
  }
  if (predicate.state === "changed") {
    return;
  }
  let matches: boolean | undefined;
  try {
    matches = known ? predicate.matches(entry) : undefined;
  } catch {
    // A failed comparison fences this claim without stranding the committed batch.
  }
  if (matches === undefined) {
    predicate.revision += 1;
    predicate.state = "unknown";
  } else if (!matches) {
    predicate.revision += 1;
    predicate.state = "changed";
  } else {
    predicate.entry = entry;
  }
}

export function revokePreparedSessionEntryPredicate(read: PreparedSessionSharingRead): void {
  if (read.predicate) {
    read.predicate.state = "changed";
    read.predicate.revision += 1;
  }
}

/** Partial publications change only their named fields, independently of row-cache warmth. */
export function projectSessionEntryPredicateChange(
  predicate: PreparedSessionEntryPredicate,
  change: SessionRowFacts,
): SessionEntry | undefined {
  const entry = predicate.entry;
  if (!entry) {
    return undefined;
  }
  switch (change.kind) {
    case "owner":
      return entry.sessionId === change.sessionId &&
        (entry.lifecycleRevision ?? null) === change.lifecycleRevision
        ? { ...entry, owner: change.owner }
        : undefined;
    case "participants":
      return change.projection
        ? { ...entry, participants: undefined, participantCount: undefined, ...change.projection }
        : undefined;
    case "category":
      return entry.sessionId === change.sessionId
        ? { ...entry, category: change.category ?? undefined }
        : undefined;
    case "member":
      return entry.sessionId === change.sessionId ? entry : undefined;
    default:
      return undefined;
  }
}

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
  } else {
    // Same-generation policy changes must narrow retained execution before its next effect.
    generation.current = entry;
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
