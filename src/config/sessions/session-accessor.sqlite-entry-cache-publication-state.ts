import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionRowChange, SessionRowFacts } from "../../sessions/session-row-changes.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { findOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  assertSessionEntryCreationCurrent,
  readSessionEntryCreationIdentity,
  projectSessionSharingEntry,
  type CreatedSessionEntryReceipt,
  type CreationRecord,
  type PendingSessionEntryPublication,
  type PreparedSessionEntryChanges,
  type PlaceholderReceipt,
  type SessionEntryCacheDatabase,
  type SessionEntryCreationOperation,
  type SessionEntryPlaceholder,
  type SessionEntryPublicationRecord,
  type SessionEntryReplacementPublication,
  type SessionSharingEntry,
} from "./session-accessor.sqlite-entry-cache.types.js";
import { stageIncognitoSharingPublication } from "./session-accessor.sqlite-incognito-sharing.js";
import {
  projectSessionEntryPredicateChange,
  publishRetainedSessionEntryPredicate,
  publishRetainedSessionGeneration,
  recordAcquiringSessionEntry,
  reconcileSessionSharingAcquisition,
  type CommittedSessionSharingFacts,
  type PreparedSessionEntryPredicate,
  type PreparedSessionSharingRead,
  type SessionSharingRetentionRequest,
} from "./session-accessor.sqlite-sharing-acquisition.js";
import type { SessionEntry } from "./types.js";

export const preparedSharingReads = resolveGlobalSingleton(
  Symbol.for("openclaw.preparedSessionSharingReads"),
  () => new Map<string, Set<PreparedSessionSharingRead>>(),
);
export const pendingSessionEntryPublications = resolveGlobalSingleton(
  Symbol.for("openclaw.pendingSessionEntryPublications"),
  () => new Map<string, Set<PendingSessionEntryPublication>>(),
);

export function stageSessionSharingPublication(
  database: SessionEntryCacheDatabase,
  sessionKey: string,
  change?: Extract<SessionRowFacts, { kind: "member" | "owner" }>,
) {
  const releaseIncognito = !database.db.location()
    ? stageIncognitoSharingPublication(database.db, sessionKey)
    : undefined;
  const reads = [...(retainedSharingReads(database, sessionKey) ?? [])];
  const token = {};
  for (const read of reads) {
    read.pending.add(token);
    const predicate = read.predicate;
    const postimage = predicate && change && projectSessionEntryPredicateChange(predicate, change);
    // A known partial assignment may leave this reader's selected metadata unchanged.
    if (predicate && (!postimage || !predicate.matches(postimage))) {
      predicate.pending.add(token);
    }
  }
  return () => {
    releaseIncognito?.();
    for (const read of reads) {
      read.pending.delete(token);
      read.predicate?.pending.delete(token);
    }
  };
}

export function recordCommittedSessionEntryPublication(
  database: SessionEntryCacheDatabase | string,
  sessionKey: string,
  entry: Pick<SessionEntry, "sessionId" | "lifecycleRevision"> | undefined,
  before?: PendingSessionEntryPublication,
): void {
  const identity =
    typeof database === "string" ? database : findOpenClawAgentDatabaseIdentity(database)?.identity;
  if (typeof identity !== "string") {
    return;
  }
  for (const pending of pendingSessionEntryPublications.get(`file:${identity}\0${sessionKey}`) ??
    []) {
    if (pending === before) {
      break;
    }
    pending.superseded.set(
      sessionKey,
      entry
        ? { sessionId: entry.sessionId, lifecycleRevision: entry.lifecycleRevision }
        : undefined,
    );
  }
}

export function recordCommittedSessionMetadataPublication(
  database: SessionEntryCacheDatabase,
  sessionKey: string,
  change?: SessionRowFacts,
  entry?: SessionEntry,
): void {
  for (const read of retainedSharingReads(database, sessionKey) ?? []) {
    const postimage =
      entry ??
      (read.predicate && change
        ? projectSessionEntryPredicateChange(read.predicate, change)
        : undefined);
    publishRetainedSessionEntryPredicate(read, postimage, postimage !== undefined);
  }
  const identity = findOpenClawAgentDatabaseIdentity(database)?.identity;
  if (typeof identity === "string") {
    for (const pending of pendingSessionEntryPublications.get(`file:${identity}\0${sessionKey}`) ??
      []) {
      pending.metadataSuperseded.add(sessionKey);
    }
  }
}

export function recordCommittedSessionOwnerPublication(
  database: SessionEntryCacheDatabase,
  sessionKey: string,
  change: Extract<SessionRowFacts, { kind: "owner" }>,
): void {
  const identity = findOpenClawAgentDatabaseIdentity(database)?.identity;
  if (typeof identity === "string") {
    for (const pending of pendingSessionEntryPublications.get(`file:${identity}\0${sessionKey}`) ??
      []) {
      // A field update supersedes its value, not the pending entry's generation fence.
      pending.ownerChanges.set(sessionKey, structuredClone(change));
    }
  }
}

/** Commit receipts remain current only until their stored fields are superseded. */
export function readCurrentSessionEntryProjection(
  owner: PendingSessionEntryPublication,
  replacement: SessionEntryReplacementPublication | undefined,
  sessionKey: string,
) {
  return !owner.superseded.has(sessionKey) &&
    !owner.metadataSuperseded.has(sessionKey) &&
    !owner.projectionSuperseded.has(sessionKey)
    ? replacement?.projection?.get(sessionKey)
    : undefined;
}

export function isSessionEntryReplacementIdentityCurrent(
  owner: PendingSessionEntryPublication,
  replacement: SessionEntryReplacementPublication | undefined,
  sessionKey: string,
): boolean {
  if (!owner.superseded.has(sessionKey)) {
    return true;
  }
  const native = owner.superseded.get(sessionKey);
  const committed = replacement?.current.get(sessionKey);
  // A later metadata write supersedes sharing facts, but retains this lifecycle transition.
  return (
    native !== undefined &&
    committed !== undefined &&
    native.sessionId === committed.sessionId &&
    native.lifecycleRevision === committed.lifecycleRevision
  );
}

export function prepareSessionEntryReplacementChanges(
  owner: PendingSessionEntryPublication,
  replacement: SessionEntryReplacementPublication,
  databaseIdentity: string,
  transcriptUnchanged: boolean,
): PreparedSessionEntryChanges | undefined {
  if (replacement.source?.identity !== databaseIdentity) {
    return undefined;
  }
  const current = (key: string) => !owner.superseded.has(key);
  return {
    source: replacement.source,
    entries: new Map(
      [...replacement.current]
        .filter(([key]) => current(key) && !owner.metadataSuperseded.has(key))
        .map(([key, entry]) => [key, freezeJsonSnapshot(entry)]),
    ),
    sharing: new Map(
      [...replacement.current]
        .filter(([key]) => current(key))
        .map(([key, entry]) => [key, projectSessionSharingEntry(entry)]),
    ),
    projection:
      replacement.projection &&
      new Map(
        [...replacement.projection]
          .filter(
            ([key, facts]) =>
              readCurrentSessionEntryProjection(owner, replacement, key) !== undefined &&
              (facts.activitySummaryWatermark === undefined || transcriptUnchanged),
          )
          .map(([key, facts]) => [key, freezeJsonSnapshot(facts)]),
      ),
  };
}

export function applyPendingSessionEntryOwnerChanges(
  replacement: SessionEntryReplacementPublication | undefined,
  ownerChanges: PendingSessionEntryPublication["ownerChanges"],
): SessionEntryReplacementPublication | undefined {
  if (!replacement || ownerChanges.size === 0) {
    return replacement;
  }
  const current = new Map(replacement.current);
  for (const [sessionKey, change] of ownerChanges) {
    const entry = current.get(sessionKey);
    if (
      !entry ||
      entry.sessionId !== change.sessionId ||
      (entry.lifecycleRevision ?? null) !== change.lifecycleRevision
    ) {
      continue;
    }
    const { owner: _previousOwner, ...metadata } = entry;
    current.set(
      sessionKey,
      freezeJsonSnapshot({ ...metadata, ...(change.owner ? { owner: change.owner } : {}) }),
    );
  }
  return { ...replacement, current };
}

export function publishRetainedSessionEntryChange(
  database: SessionEntryCacheDatabase | string,
  sessionKey: string,
  entry: SessionSharingEntry | undefined,
  previousIdentity: Pick<SessionSharingEntry, "sessionId" | "lifecycleRevision"> | undefined,
  known: boolean,
  metadataEntry?: SessionEntry,
): void {
  recordCommittedSessionEntryPublication(database, sessionKey, entry);
  for (const read of retainedSharingReads(database, sessionKey) ?? []) {
    publishRetainedSessionEntryPredicate(read, metadataEntry, known);
    recordAcquiringSessionEntry(read.acquisition, entry, previousIdentity);
    publishRetainedSessionGeneration(read, entry, known);
    const previous = read.facts;
    read.facts =
      entry &&
      previous?.entry &&
      previous.entry.sessionId === entry.sessionId &&
      previous.entry.lifecycleRevision === entry.lifecycleRevision
        ? { entry, membership: previous.membership }
        : undefined;
  }
}

/** The existing entry writer advances retained facts before any commit observer can reenter. */
export function retainPreparedSessionSharingFacts(params: SessionSharingRetentionRequest) {
  const key = `${params.databaseIdentity}\0${params.sessionKey}`;
  const initial = "acquiring" in params ? undefined : params;
  const read: PreparedSessionSharingRead = {
    predicate: params.predicate,
    pending: new Set(),
    facts: initial && {
      entry: initial.entry,
      placeholder: initial.placeholder,
      membership: initial.membership,
    },
    generation: initial?.generation,
    acquisition: initial ? undefined : { invalidated: false, membership: new Map() },
  };
  const reads = preparedSharingReads.get(key) ?? new Set<PreparedSessionSharingRead>();
  reads.add(read);
  preparedSharingReads.set(key, reads);
  let active = true;
  const pending = (membership: boolean, staged = read.pending) =>
    staged.size > 0 ||
    [...(pendingSessionEntryPublications.get(key) ?? [])].some(
      (publication) =>
        !publication.settled &&
        ((!publication.superseded.has(params.sessionKey) &&
          (!membership || !publication.sharingUnchanged.has(params.sessionKey))) ||
          (membership && publication.membershipInvalidated.has(params.sessionKey))),
    );
  // Generation readers compare only sessionId and lifecycleRevision, so a publication
  // whose committed rows prove both unchanged cannot alter a synchronous generation read.
  // prepareRead still joins every pending publication: owners order effects after it.
  const generationPending = () =>
    read.pending.size > 0 ||
    [...(pendingSessionEntryPublications.get(key) ?? [])].some(
      (publication) =>
        !publication.settled &&
        !publication.superseded.has(params.sessionKey) &&
        !publication.generationUnchanged.has(params.sessionKey),
    );
  return {
    hasPendingPublication: () => pending(false, read.predicate?.pending),
    prepareRead: (): Promise<void> | undefined => {
      // Publication begins only after writer admission; queued writers cannot block their owner.
      const completions = [...(pendingSessionEntryPublications.get(key) ?? [])].flatMap(
        (publication) =>
          !publication.settled && !publication.superseded.has(params.sessionKey)
            ? [publication.completion]
            : [],
      );
      return completions.length > 0 ? Promise.all(completions).then(() => {}) : undefined;
    },
    initialize: (snapshot: CommittedSessionSharingFacts) => {
      const acquisition = read.acquisition;
      if (!active || !acquisition) {
        throw new Error("Session sharing acquisition is no longer current");
      }
      read.facts = reconcileSessionSharingAcquisition(acquisition, snapshot);
      read.acquisition = undefined;
    },
    readGeneration: () => (active && !generationPending() ? read.generation?.current : undefined),
    readGenerationSettings: () => (active && !pending(true) ? read.generation?.current : undefined),
    readCurrent: () => (pending(true) ? undefined : read.facts),
    release: () => {
      if (!active) {
        return;
      }
      active = false;
      read.facts = undefined;
      read.acquisition = undefined;
      reads.delete(read);
      if (reads.size === 0 && preparedSharingReads.get(key) === reads) {
        preparedSharingReads.delete(key);
      }
    },
  };
}

/** Exact reader consumers acknowledge refreshes before releasing their physical source. */
export function retainPreparedSessionEntryPredicate(params: {
  databaseIdentity: string;
  sessionKey: string;
  entry: SessionEntry | undefined;
  matches: (before: SessionEntry | undefined, after: SessionEntry | undefined) => boolean;
}) {
  const predicate: PreparedSessionEntryPredicate = {
    entry: params.entry,
    matches: (entry) => params.matches(params.entry, entry),
    state: "current",
    revision: 0,
    pending: new Set(),
  };
  const retained = retainPreparedSessionSharingFacts({
    ...params,
    predicate,
    membership: new Set(),
  });
  let active = true;
  const canRefresh = () => active && predicate.state !== "changed";
  return {
    isCurrent: () =>
      canRefresh() && predicate.state === "current" && !retained.hasPendingPublication(),
    canRefresh,
    captureRevision: () => predicate.revision,
    acknowledge: (entry: SessionEntry | undefined, revision: number) => {
      if (!canRefresh() || retained.hasPendingPublication() || revision !== predicate.revision) {
        return false;
      }
      if (!predicate.matches(entry)) {
        predicate.state = "changed";
        return false;
      }
      predicate.entry = entry;
      predicate.state = "current";
      return true;
    },
    release: () => {
      active = false;
      retained.release();
    },
  };
}

/** Generation custody shares the entry publication owner, independently of membership. */
export function retainPreparedSessionGenerationFacts(params: {
  databaseIdentity: string;
  sessionKey: string;
  entry: SessionSharingEntry | undefined;
}) {
  const generation: NonNullable<PreparedSessionSharingRead["generation"]> = {
    current: params.entry ?? null,
    initiallyAbsent: params.entry ? undefined : true,
  };
  const retained = retainPreparedSessionSharingFacts({
    ...params,
    membership: new Set(),
    generation,
  });
  return {
    adoptCreatedEntry: (entry: SessionSharingEntry) => {
      if (!generation.initiallyAbsent || retained.readGeneration() !== entry) {
        return false;
      }
      generation.initiallyAbsent = undefined;
      return true;
    },
    readCurrent: retained.readGeneration,
    readSessionSettings: retained.readGenerationSettings,
    prepareRead: retained.prepareRead,
    release: retained.release,
  };
}

export function retainedSharingReads(
  database: SessionEntryCacheDatabase | string,
  sessionKey: string,
) {
  const identity =
    typeof database === "string" ? database : findOpenClawAgentDatabaseIdentity(database)?.identity;
  return typeof identity === "string"
    ? preparedSharingReads.get(`file:${identity}\0${sessionKey}`)
    : undefined;
}

type PreparedSharingChangeRegistry = {
  changes: WeakMap<object, SessionEntryPublicationRecord>;
  operations: WeakMap<SessionEntryCreationOperation, CreationRecord>;
  current: AsyncLocalStorage<CreationRecord>;
};

export const preparedSharingChanges: PreparedSharingChangeRegistry = resolveGlobalSingleton(
  Symbol.for("openclaw.preparedSessionSharingChanges"),
  () => ({
    changes: new WeakMap<object, SessionEntryPublicationRecord>(),
    operations: new WeakMap<SessionEntryCreationOperation, CreationRecord>(),
    current: new AsyncLocalStorage<CreationRecord>(),
  }),
);

function readSessionEntryCreationReceipt(
  change: SessionRowChange,
  operation: SessionEntryCreationOperation,
): PlaceholderReceipt | CreatedSessionEntryReceipt | undefined {
  const record = preparedSharingChanges.changes.get(change);
  const receipt =
    record?.kind === "placeholder"
      ? record.receipt
      : record?.kind === "metadata"
        ? record.creation
        : undefined;
  const creation = preparedSharingChanges.operations.get(operation);
  if (!creation) {
    return undefined;
  }
  try {
    assertSessionEntryCreationCurrent(creation);
  } catch {
    return undefined;
  }
  return receipt?.committed &&
    receipt.creation === creation &&
    receipt.databaseIdentity === readSessionEntryCreationIdentity(creation) &&
    receipt.sessionKey === creation.sessionKey
    ? receipt
    : undefined;
}

export function readSessionEntryCreationTransition(
  change: SessionRowChange,
  operation: SessionEntryCreationOperation,
): SessionEntryPlaceholder | undefined {
  const receipt = readSessionEntryCreationReceipt(change, operation);
  return receipt?.kind === "placeholder" ? receipt.placeholder : undefined;
}

/** Full-row creation is authoritative only from the bound writer's settled COMMIT receipt. */
export function readSessionEntryCreatedEntry(
  change: SessionRowChange,
  operation: SessionEntryCreationOperation,
) {
  const receipt = readSessionEntryCreationReceipt(change, operation);
  return receipt?.kind === "entry" ? receipt.entry : undefined;
}

/** Private owner metadata follows the original event object without changing its public fields. */
export function isPreparedSessionSharingChange(change: SessionRowChange): boolean {
  const record = preparedSharingChanges.changes.get(change);
  return record !== undefined && record.kind !== "source";
}

export function readPreparedSessionSharingChange(change: object) {
  const record = preparedSharingChanges.changes.get(change);
  return record && "sharingChange" in record ? record.sharingChange : undefined;
}

/** Physical publication facts are captured by the writer, never resolved by observers. */
export function readPreparedSessionEntryPublicationSource(change: object) {
  const record = preparedSharingChanges.changes.get(change);
  const source = record?.kind === "metadata" ? record.prepared.source : undefined;
  return {
    identity: record?.databaseIdentity ?? source?.identity,
    canonicalPath: record?.canonicalPath ?? source?.canonicalPath,
  };
}

/** Commit metadata follows the same original row or identity event through preparation. */
export function readPreparedSessionEntryChange(change: object, sessionKey: string) {
  const record = preparedSharingChanges.changes.get(change);
  if (record?.kind !== "metadata") {
    return undefined;
  }
  const { prepared } = record;
  const entry = prepared.entries.get(sessionKey);
  return {
    source: prepared.source,
    entry,
    sharing:
      prepared.sharing?.get(sessionKey) ?? (entry ? projectSessionSharingEntry(entry) : undefined),
    projection: prepared.projection?.get(sessionKey),
  };
}
