import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import {
  sessionRowChangeSource,
  type SessionRowChange,
  type SessionRowFacts,
} from "../../sessions/session-row-changes.js";
import { resolveGlobalSet, resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { findOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
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
import {
  projectSessionEntryPredicateChange,
  projectSessionEntryPredicatePostimage,
  publishRetainedSessionEntryPredicate,
  publishRetainedSessionGeneration,
  recordAcquiringSessionEntry,
  reconcileSessionSharingAcquisition,
  type CommittedSessionSharingFacts,
  type PreparedSessionEntryPredicate,
  type PreparedSessionSharingRead,
  type SessionSharingRetentionRequest,
} from "./session-accessor.sqlite-sharing-acquisition.js";
import type { SessionEntryProjection } from "./session-entry-snapshot-values.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export const preparedSharingReads = resolveGlobalSingleton(
  Symbol.for("openclaw.preparedSessionSharingReads"),
  () => new Map<string, Set<PreparedSessionSharingRead>>(),
);
export const pendingSessionEntryPublications = resolveGlobalSingleton(
  Symbol.for("openclaw.pendingSessionEntryPublications"),
  () => new Map<string, Set<PendingSessionEntryPublication>>(),
);
const unknownSharingAuthorities = resolveGlobalSet<string>(
  Symbol.for("openclaw.unknownSessionSharingAuthorities"),
  "close-and-restart",
);

/** ID selection cannot pass a worker commit whose identity facts are not yet published. */
export function isSessionIdSelectionPublished(params: {
  databaseIdentity: string;
  sessionId: string;
  sessionKey?: string;
}): boolean {
  const prefix = `${params.databaseIdentity}\0`;
  for (const key of unknownSharingAuthorities) {
    if (key.startsWith(prefix)) {
      return false;
    }
  }
  for (const [key, publications] of pendingSessionEntryPublications) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    const sessionKey = key.slice(prefix.length);
    for (const publication of publications) {
      if (
        !publication.settled &&
        !publication.superseded.has(sessionKey) &&
        !publication.generationUnchanged.has(sessionKey) &&
        (sessionKey === params.sessionKey ||
          !publication.entryPostimages?.has(sessionKey) ||
          publication.entryPostimages.get(sessionKey)?.sessionId?.trim() ===
            params.sessionId.trim())
      ) {
        return false;
      }
    }
  }
  return true;
}

/** A fresh snapshot cannot settle a write whose outcome the authority owner lost. */
export function markSessionSharingAuthorityUnknown(
  database: SessionEntryCacheDatabase | string,
  sessionKey: string,
): void {
  const identity =
    typeof database === "string" ? database : findOpenClawAgentDatabaseIdentity(database)?.identity;
  if (typeof identity === "string") {
    unknownSharingAuthorities.add(`file:${identity}\0${sessionKey}`);
  }
}

export function stageSessionSharingPublication(
  database: SessionEntryCacheDatabase,
  sessionKey: string,
  change?: Extract<SessionRowFacts, { kind: "member" | "owner" }>,
) {
  const reads = [...(retainedSharingReads(database, sessionKey) ?? [])];
  const token = {};
  const release = () => {
    for (const read of reads) {
      read.pending.delete(token);
      read.predicate?.pending.delete(token);
    }
  };
  try {
    for (const read of reads) {
      read.pending.add(token);
      const predicate = read.predicate;
      const postimage =
        predicate && change && projectSessionEntryPredicateChange(predicate, change);
      // A known partial assignment may leave this reader's selected metadata unchanged.
      if (predicate && (!postimage || !predicate.matches(postimage))) {
        predicate.pending.add(token);
      }
    }
  } catch (error) {
    release();
    throw error;
  }
  return release;
}

export function recordCommittedSessionEntryPublication(
  database: SessionEntryCacheDatabase | string,
  sessionKey: string,
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
    pending.superseded.add(sessionKey);
  }
}

export function recordCommittedSessionMetadataPublication(
  database: SessionEntryCacheDatabase | string,
  sessionKey: string,
  change?: SessionRowFacts,
  entry?: SessionEntry,
  fullEntry?: SessionEntry,
): void {
  for (const read of retainedSharingReads(database, sessionKey) ?? []) {
    const postimage =
      entry ??
      (read.predicate && change
        ? projectSessionEntryPredicateChange(read.predicate, change)
        : undefined);
    publishRetainedSessionEntryPredicate(read, postimage, postimage !== undefined, {
      fullEntry: entry ? fullEntry : postimage,
    });
  }
  recordCommittedSessionEntryPublication(database, sessionKey);
}

/** Commit receipts remain current only until their stored fields are superseded. */
export function readCurrentSessionEntryProjection(
  owner: PendingSessionEntryPublication,
  replacement: SessionEntryReplacementPublication | undefined,
  sessionKey: string,
) {
  return !owner.superseded.has(sessionKey) ? replacement?.projection?.get(sessionKey) : undefined;
}

function prepareSessionEntryReplacementChanges(
  owner: PendingSessionEntryPublication,
  replacement: SessionEntryReplacementPublication,
  databaseIdentity: string,
): PreparedSessionEntryChanges | undefined {
  if (replacement.source?.identity !== databaseIdentity) {
    return undefined;
  }
  const current = (key: string) => !owner.superseded.has(key);
  const snapshot = <T>(entries: ReadonlyMap<string, T>, participants = false) =>
    new Map(
      [...entries].filter(
        ([key]) =>
          current(key) && (!participants || !replacement.unavailableParticipantKeys?.includes(key)),
      ),
    );
  return {
    source: replacement.source,
    entries: snapshot(replacement.current, true),
    fullEntries: replacement.fullEntries && snapshot(replacement.fullEntries, true),
    actorPostimages: replacement.actorPostimages && snapshot(replacement.actorPostimages),
    sharing: new Map(
      [...replacement.current]
        .filter(([key]) => current(key))
        .map(([key, entry]) => [key, projectSessionSharingEntry(entry)]),
    ),
    projection: replacement.projection && snapshot(replacement.projection),
  };
}

/** Capture acknowledged facts while their existing publication owner keeps delivery current. */
export function prepareSessionEntryPublicationFacts(params: {
  replacement: SessionEntryReplacementPublication | undefined;
  owner: PendingSessionEntryPublication;
  databaseIdentity: string;
  unknown: boolean;
}) {
  const { replacement, owner, databaseIdentity, unknown } = params;
  const current = (key: string) => !owner.superseded.has(key);
  const prepared =
    !unknown && replacement
      ? prepareSessionEntryReplacementChanges(owner, replacement, databaseIdentity)
      : undefined;
  const currentMetadata = (key: string) => current(key) && replacement !== undefined;
  const readCurrent = (key: string) => {
    if (!currentMetadata(key)) {
      return undefined;
    }
    const entry = prepared?.entries.get(key);
    if (!entry) {
      const metadata = replacement?.unavailableParticipantKeys?.includes(key)
        ? replacement.current.get(key)
        : undefined;
      // Missing participant display cannot erase acknowledged identity or certify an empty row.
      return metadata
        ? {
            entry: undefined,
            projection: undefined,
            sharing: projectSessionSharingEntry(metadata),
          }
        : undefined;
    }
    const projection = readCurrentSessionEntryProjection(owner, replacement, key)
      ? prepared?.projection?.get(key)
      : undefined;
    return {
      entry,
      sharing: prepared?.sharing?.get(key),
      fullEntry: prepared?.fullEntries?.get(key),
      actorPostimage: prepared?.actorPostimages?.get(key),
      projection,
    };
  };
  return { prepared, currentMetadata, readCurrent };
}

export function publishRetainedSessionEntryChange(
  database: SessionEntryCacheDatabase | string,
  sessionKey: string,
  entry: SessionSharingEntry | undefined,
  previousIdentity: Pick<SessionSharingEntry, "sessionId" | "lifecycleRevision"> | undefined,
  known: boolean,
  metadataEntry?: SessionEntry,
  fullEntry?: SessionEntry,
): void {
  recordCommittedSessionEntryPublication(database, sessionKey);
  for (const read of retainedSharingReads(database, sessionKey) ?? []) {
    publishRetainedSessionEntryPredicate(read, metadataEntry, known, { fullEntry });
    recordAcquiringSessionEntry(read.acquisition, entry, previousIdentity);
    publishRetainedSessionGeneration(read, entry, known);
    const previous = read.facts;
    read.facts =
      entry &&
      previous?.entry &&
      previous.entry.sessionId === entry.sessionId &&
      (read.followLifecycle || previous.entry.lifecycleRevision === entry.lifecycleRevision)
        ? { entry, membership: previous.membership }
        : undefined;
  }
}

/** The existing entry writer advances retained facts before any commit observer can reenter. */
export function retainPreparedSessionSharingFacts(params: SessionSharingRetentionRequest) {
  const { sessionKey } = params;
  const key = `${params.databaseIdentity}\0${sessionKey}`;
  const initial = "acquiring" in params ? undefined : params;
  const read: PreparedSessionSharingRead = {
    followLifecycle: params.followLifecycle,
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
  const pending = () =>
    read.pending.size > 0 ||
    [...(pendingSessionEntryPublications.get(key) ?? [])].some(
      (publication) =>
        !publication.settled &&
        ((!publication.superseded.has(sessionKey) &&
          !publication.sharingUnchanged.has(sessionKey)) ||
          publication.membershipInvalidated.has(sessionKey)),
    );
  // Unchanged identity and settings remain usable during unrelated metadata writes.
  // prepareRead still joins publications; pending policy changes cannot donate old grants.
  const generationPending = (settings = false) =>
    read.pending.size > 0 ||
    [...(pendingSessionEntryPublications.get(key) ?? [])].some((publication) => {
      if (publication.settled) {
        return false;
      }
      if (settings && publication.membershipInvalidated.has(sessionKey)) {
        return true;
      }
      if (publication.superseded.has(sessionKey)) {
        return false;
      }
      if (!publication.generationUnchanged.has(sessionKey)) {
        return true;
      }
      if (!settings || publication.sharingUnchanged.has(sessionKey)) {
        return false;
      }
      const entry = publication.entryPostimages?.get(sessionKey);
      const current = read.generation?.current;
      return (
        !entry ||
        !current ||
        entry.permissionMode !== current.permissionMode ||
        !isDeepStrictEqual(entry.toolOverrides, current.toolOverrides)
      );
    });
  const predicatePending = () =>
    (read.predicate?.pending.size ?? 0) > 0 ||
    [...(pendingSessionEntryPublications.get(key) ?? [])].some((publication) => {
      if (publication.settled || publication.superseded.has(sessionKey)) {
        return false;
      }
      const entryPostimage = publication.entryPostimages?.get(sessionKey);
      if (read.predicate && entryPostimage) {
        // These fields are unchanged whether the pending transaction commits or rolls back.
        try {
          const postimage = projectSessionEntryPredicatePostimage(
            read.predicate,
            entryPostimage,
            publication.fullEntryPostimages?.get(sessionKey),
          );
          return !postimage.known || !read.predicate.matches(postimage.entry);
        } catch {
          return true;
        }
      }
      if (!read.predicate || !publication.participantProjections?.has(sessionKey)) {
        return true;
      }
      const projection = publication.participantProjections.get(sessionKey);
      if (!projection) {
        return false;
      }
      const postimage = projectSessionEntryPredicateChange(read.predicate, {
        kind: "participants",
        projection,
      });
      try {
        return !postimage || !read.predicate.matches(postimage);
      } catch {
        return true;
      }
    });
  return {
    hasPendingPublication: predicatePending,
    prepareRead: (): Promise<void> | undefined => {
      // Publication begins only after writer admission; queued writers cannot block their owner.
      const completions = [...(pendingSessionEntryPublications.get(key) ?? [])].flatMap(
        (publication) =>
          !publication.settled && !publication.superseded.has(sessionKey)
            ? [publication.completion]
            : [],
      );
      return completions.length > 0 ? Promise.all(completions).then(() => {}) : undefined;
    },
    initialize: (snapshot: CommittedSessionSharingFacts) => {
      const acquisition = read.acquisition;
      if (!active || !acquisition || unknownSharingAuthorities.has(key)) {
        throw new Error("Session sharing acquisition is no longer current");
      }
      read.facts = reconcileSessionSharingAcquisition(acquisition, snapshot);
      read.acquisition = undefined;
      return read.facts;
    },
    adoptCreatedEntry: (entry: SessionSharingEntry) => {
      read.facts = { entry, membership: new Set() };
    },
    readGeneration: () => (active && !generationPending() ? read.generation?.current : undefined),
    readGenerationSettings: () =>
      active && !generationPending(true) ? read.generation?.current : undefined,
    readCurrent: () => (pending() || unknownSharingAuthorities.has(key) ? undefined : read.facts),
    release: () => {
      if (!active) {
        return;
      }
      active = false;
      read.facts = undefined;
      read.acquisition = undefined;
      read.predicate = undefined;
      if (read.generation) {
        read.generation.current = undefined;
        read.generation = undefined;
      }
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
  acquiring?: boolean;
  projection?: SessionEntryProjection;
}) {
  const { acquiring, ...retention } = params;
  let originalEntry = params.entry;
  let matches: typeof params.matches | undefined = params.matches;
  const predicate: PreparedSessionEntryPredicate = {
    entry: params.entry,
    matches: (entry) => matches?.(acquiring ? predicate.entry : originalEntry, entry) ?? false,
    state: acquiring ? "acquiring" : "current",
    revision: 0,
    pending: new Set(),
    projection: params.projection,
  };
  const retained = retainPreparedSessionSharingFacts({
    ...retention,
    predicate,
    membership: new Set(),
  });
  let active = true;
  const canRefresh = () => active && predicate.state !== "changed";
  const isCurrent = () =>
    canRefresh() && predicate.state === "current" && !retained.hasPendingPublication();
  return {
    prepareRead: retained.prepareRead,
    isCurrent,
    readRetainedEntry: () => predicate.entry,
    readCurrent: () => (isCurrent() ? { entry: structuredClone(predicate.entry) } : undefined),
    canRefresh,
    captureRevision: () => predicate.revision,
    acknowledge: (entry: SessionEntry | undefined, revision: number) => {
      if (!canRefresh()) {
        return false;
      }
      if (predicate.state === "acquiring" && predicate.revision === 0) {
        predicate.entry = entry;
      }
      if (
        retained.hasPendingPublication() ||
        (revision !== predicate.revision && predicate.state !== "acquiring")
      ) {
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
      // Released guards may outlive their operation in captured authority callbacks.
      originalEntry = undefined;
      matches = undefined;
      predicate.entry = undefined;
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
  current: AsyncLocalStorage<CreationRecord | undefined>;
};

export const preparedSharingChanges: PreparedSharingChangeRegistry = resolveGlobalSingleton(
  Symbol.for("openclaw.preparedSessionSharingChanges"),
  () => ({
    changes: new WeakMap<object, SessionEntryPublicationRecord>(),
    operations: new WeakMap<SessionEntryCreationOperation, CreationRecord>(),
    current: new AsyncLocalStorage<CreationRecord | undefined>(),
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
  // Receipt provenance lasts for the operation; effect owners still validate live authority.
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
  const record = preparedSharingChanges.changes.get(sessionRowChangeSource(change));
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
  const current = record.readCurrent?.(sessionKey);
  const entry = record.readCurrent ? current?.entry : prepared.entries.get(sessionKey);
  // A withheld postimage must still identify the store that committed the change.
  return {
    source: prepared.source,
    entry,
    fullEntry: record.readCurrent ? current?.fullEntry : prepared.fullEntries?.get(sessionKey),
    actorPostimage: record.readCurrent
      ? current?.actorPostimage
      : prepared.actorPostimages?.get(sessionKey),
    sharing: record.readCurrent
      ? (current?.sharing ?? (current?.entry && projectSessionSharingEntry(current.entry)))
      : (prepared.sharing?.get(sessionKey) ??
        (entry ? projectSessionSharingEntry(entry) : undefined)),
    projection: record.readCurrent ? current?.projection : prepared.projection?.get(sessionKey),
  };
}
