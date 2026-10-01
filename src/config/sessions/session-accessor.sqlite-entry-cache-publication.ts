import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  sessionChanges,
  type SessionRowChange,
  type SessionRowFacts,
} from "../../sessions/session-row-changes.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { findOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { invalidateOpenClawAgentWritableProjections } from "../../state/openclaw-agent-db-lifecycle.js";
import { invalidateOpenClawAgentReadOnlyProjections } from "../../state/openclaw-agent-db-readonly-scope.js";
import {
  publishTrackedCacheUpdate,
  sessionEntryCaches,
} from "./session-accessor.sqlite-entry-cache-state.js";
import {
  createSessionEntryCreationOperation,
  projectSessionSharingEntry,
  type SessionEntryCacheDatabase,
  type SessionEntryCreationOperation,
  type SessionEntryPlaceholder,
  type SessionTranscriptInitializationPublication,
  type SessionSharingEntry,
} from "./session-accessor.sqlite-entry-cache.types.js";
import {
  commitIncognitoSessionSharingFacts,
  commitIncognitoSessionSharingField,
  publishIncognitoSessionEntryChange,
  stageIncognitoSharingPublication,
} from "./session-accessor.sqlite-incognito-sharing.js";
import {
  publishRetainedSessionGeneration,
  reconcileSessionSharingAcquisition,
  updateSessionSharingField,
  recordAcquiringSessionEntry,
  recordAcquiringSessionMember,
  type CommittedSessionSharingFacts,
  type PreparedSessionSharingRead,
  type SessionSharingRetentionRequest,
} from "./session-accessor.sqlite-sharing-acquisition.js";
import type { SessionEntry } from "./types.js";

type CreationDatabase =
  | {
      kind: "native";
      database: SessionEntryCacheDatabase & { path: string };
      agentId: string | undefined;
    }
  | {
      kind: "file";
      path: string;
      agentId: string;
      databaseIdentity: string;
      assertCurrent: () => void;
    };
type CreationRecord = {
  agentId: string;
  source: CreationDatabase;
  sessionKey: string;
  active: boolean;
};
type PlaceholderReceipt = {
  creation: CreationRecord | undefined;
  databaseIdentity: DatabaseSync | string;
  sessionKey: string;
  placeholder: SessionEntryPlaceholder;
  committed: boolean;
};

export type SessionEntryReplacementPublication = {
  kind: "session-entry-replacements";
  pendingArchiveRecovery: boolean;
  previous: Map<string, Pick<SessionEntry, "sessionId" | "lifecycleRevision">>;
  current: Map<string, SessionSharingEntry>;
  changedKeys: string[];
  membershipInvalidatedKeys: string[];
};

const preparedSharingReads = resolveGlobalSingleton(
  Symbol.for("openclaw.preparedSessionSharingReads"),
  () => new Map<string, Set<PreparedSessionSharingRead>>(),
);
const preparedSharingChanges = resolveGlobalSingleton(
  Symbol.for("openclaw.preparedSessionSharingChanges"),
  () => ({
    changes: new WeakMap<SessionRowChange, PlaceholderReceipt | undefined>(),
    operations: new WeakMap<SessionEntryCreationOperation, CreationRecord>(),
    current: new AsyncLocalStorage<CreationRecord>(),
  }),
);

type PendingSessionEntryPublication = {
  superseded: Map<string, Pick<SessionEntry, "sessionId" | "lifecycleRevision"> | undefined>;
  membershipInvalidated: Set<string>;
  settled: boolean;
};
const pendingSessionEntryPublications = resolveGlobalSingleton(
  Symbol.for("openclaw.pendingSessionEntryPublications"),
  () => new Map<string, Set<PendingSessionEntryPublication>>(),
);

function recordCommittedSessionEntryPublication(
  database: SessionEntryCacheDatabase | string,
  sessionKey: string,
  entry: SessionSharingEntry | undefined,
): void {
  const identity =
    typeof database === "string" ? database : findOpenClawAgentDatabaseIdentity(database)?.identity;
  if (typeof identity !== "string") {
    return;
  }
  for (const pending of pendingSessionEntryPublications.get(`file:${identity}\0${sessionKey}`) ??
    []) {
    pending.superseded.set(
      sessionKey,
      entry
        ? { sessionId: entry.sessionId, lifecycleRevision: entry.lifecycleRevision }
        : undefined,
    );
  }
}

/** Private owner metadata follows the original event object without changing its public fields. */
export function isPreparedSessionSharingChange(change: SessionRowChange): boolean {
  return preparedSharingChanges.changes.has(change);
}

export function emitPreparedSessionSharingChange(
  database: SessionEntryCacheDatabase & { path: string },
  sessionKey: string,
  agentId = database.agentId,
  facts?: SessionRowFacts,
  receipt?: PlaceholderReceipt,
): void {
  const change: SessionRowChange = {
    agentId,
    storePath: database.path,
    sessionKey,
    ...(facts ? { facts, scope: "session-entry" as const } : { factsInvalidated: true }),
  };
  preparedSharingChanges.changes.set(change, receipt);
  sessionChanges.emit(change, database.db);
}

/** A committed metadata-only worker write invalidates caches without changing retained identity. */
export function publishSessionEntryWorkerMetadataInvalidation(params: {
  agentId: string;
  storePath: string;
  databaseIdentity: string;
  sessionKey: string;
}): void {
  invalidateOpenClawAgentWritableProjections(params.databaseIdentity, (database) =>
    sessionEntryCaches.delete(database),
  );
  invalidateOpenClawAgentReadOnlyProjections(params.databaseIdentity, (database) =>
    sessionEntryCaches.delete(database),
  );
  const change: SessionRowChange = {
    agentId: params.agentId,
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    scope: "session-entry",
    facts: { kind: "unchanged" },
  };
  preparedSharingChanges.changes.set(change, undefined);
  sessionChanges.emit(change);
}

function assertCreationCurrent(
  creation: CreationRecord | undefined,
): asserts creation is CreationRecord {
  if (!creation?.active) {
    throw new Error("Session creation publication owner is no longer current");
  }
  const source = creation.source;
  if (source.kind === "file") {
    source.assertCurrent();
  } else if (!source.database.db.isOpen || source.database.agentId !== source.agentId) {
    throw new Error("Session creation publication owner is no longer current");
  }
}

function creationDatabaseIdentity(creation: CreationRecord): DatabaseSync | string {
  return creation.source.kind === "native"
    ? creation.source.database.db
    : creation.source.databaseIdentity;
}

function creationMatchesDatabase(creation: CreationRecord, database: SessionEntryCacheDatabase) {
  return creation.source.kind === "native"
    ? creation.source.database.db === database.db
    : creation.source.agentId === database.agentId &&
        findOpenClawAgentDatabaseIdentity(database)?.identity === creation.source.databaseIdentity;
}

/** Canonical creation scopes provenance only; caller and target guards still authorize each write. */
export async function withSessionEntryCreationPublication<T>(
  params: {
    agentId: string;
    sessionKey: string;
    bind?: (operation: SessionEntryCreationOperation) => void;
  } & (
    | { database: SessionEntryCacheDatabase & { path: string }; file?: never }
    | { database?: never; file: Omit<Extract<CreationDatabase, { kind: "file" }>, "kind"> }
  ),
  run: (operation: SessionEntryCreationOperation) => Promise<T>,
): Promise<T> {
  const operation = createSessionEntryCreationOperation();
  const creation: CreationRecord = {
    agentId: params.agentId,
    source: params.database
      ? { kind: "native", database: params.database, agentId: params.database.agentId }
      : { kind: "file", ...params.file },
    sessionKey: params.sessionKey,
    active: true,
  };
  preparedSharingChanges.operations.set(operation, creation);
  try {
    params.bind?.(operation);
    return await runWithSessionEntryCreationPublication(operation, () => run(operation));
  } finally {
    creation.active = false;
    preparedSharingChanges.operations.delete(operation);
  }
}

/** Reenter only this operation's provenance after another owner restores its own context. */
export function runWithSessionEntryCreationPublication<T>(
  operation: SessionEntryCreationOperation,
  run: () => Promise<T>,
): Promise<T> {
  const creation = preparedSharingChanges.operations.get(operation);
  assertCreationCurrent(creation);
  return preparedSharingChanges.current.run(creation, run);
}

export function assertSessionEntryCreationPublication(
  operation: SessionEntryCreationOperation,
  target: { agentId: string; sessionKey: string; paths: ReadonlySet<string> },
): void {
  const creation = preparedSharingChanges.operations.get(operation);
  assertCreationCurrent(creation);
  const sourcePath =
    creation.source.kind === "native" ? creation.source.database.path : creation.source.path;
  if (
    creation.agentId !== target.agentId ||
    creation.sessionKey !== target.sessionKey ||
    !target.paths.has(path.resolve(sourcePath))
  ) {
    throw new Error("Session creation publication owner is no longer current");
  }
}

export function readSessionEntryCreationTransition(
  change: SessionRowChange,
  operation: SessionEntryCreationOperation,
): SessionEntryPlaceholder | undefined {
  const receipt = preparedSharingChanges.changes.get(change);
  const creation = preparedSharingChanges.operations.get(operation);
  if (!creation) {
    return undefined;
  }
  try {
    assertCreationCurrent(creation);
  } catch {
    return undefined;
  }
  return receipt?.committed &&
    receipt.creation === creation &&
    receipt.databaseIdentity === creationDatabaseIdentity(creation) &&
    receipt.sessionKey === creation.sessionKey
    ? receipt.placeholder
    : undefined;
}

/** Only the actual inserted-placeholder producer supplies these known row facts. */
export function publishSessionEntryPlaceholderInsertion(
  database: SessionEntryCacheDatabase & { path: string },
  params: { sessionKey: string; sessionId: string },
): void {
  const { sessionKey, sessionId } = params;
  const placeholder = Object.freeze({ sessionId });
  const current = preparedSharingChanges.current.getStore();
  const creation =
    current?.active &&
    creationMatchesDatabase(current, database) &&
    current.sessionKey === sessionKey
      ? current
      : undefined;
  const receipt: PlaceholderReceipt = {
    creation,
    databaseIdentity: creation ? creationDatabaseIdentity(creation) : database.db,
    sessionKey,
    placeholder,
    committed: false,
  };
  const incognito = !database.db.location();
  let staged = false;
  staged = publishTrackedCacheUpdate(
    database,
    () => {
      recordCommittedSessionEntryPublication(database, sessionKey, undefined);
      const facts: CommittedSessionSharingFacts | undefined = staged
        ? { entry: undefined, placeholder, membership: new Set() }
        : undefined;
      for (const read of retainedSharingReads(database, sessionKey) ?? []) {
        if (read.acquisition) {
          read.acquisition.invalidated = true;
        }
        publishRetainedSessionGeneration(read, undefined, staged);
        read.facts = facts;
      }
      if (incognito) {
        commitIncognitoSessionSharingFacts(database.db, sessionKey, facts ?? null);
      }
      sessionEntryCaches.delete(database.db);
      receipt.committed = staged;
    },
    () => stageSessionSharingPublication(database, sessionKey),
  );
  emitPreparedSessionSharingChange(database, sessionKey, database.agentId, undefined, receipt);
}

/** The existing entry writer advances retained facts before any commit observer can reenter. */
export function retainPreparedSessionSharingFacts(params: SessionSharingRetentionRequest) {
  const key = `${params.databaseIdentity}\0${params.sessionKey}`;
  const initial = "acquiring" in params ? undefined : params;
  const read: PreparedSessionSharingRead = {
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
  const pending = (membership: boolean) =>
    read.pending.size > 0 ||
    [...(pendingSessionEntryPublications.get(key) ?? [])].some(
      (publication) =>
        !publication.settled &&
        (!publication.superseded.has(params.sessionKey) ||
          (membership && publication.membershipInvalidated.has(params.sessionKey))),
    );
  return {
    initialize: (snapshot: CommittedSessionSharingFacts) => {
      const acquisition = read.acquisition;
      if (!active || !acquisition) {
        throw new Error("Session sharing acquisition is no longer current");
      }
      read.facts = reconcileSessionSharingAcquisition(acquisition, snapshot);
      read.acquisition = undefined;
    },
    readGeneration: () => (active && !pending(false) ? read.generation?.current : undefined),
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

/** Generation custody shares the entry publication owner, independently of membership. */
export function retainPreparedSessionGenerationFacts(params: {
  databaseIdentity: string;
  sessionKey: string;
  entry: SessionSharingEntry | undefined;
}) {
  const retained = retainPreparedSessionSharingFacts({
    ...params,
    membership: new Set(),
    generation: { current: params.entry ?? null, initiallyAbsent: params.entry ? undefined : true },
  });
  return { readCurrent: retained.readGeneration, release: retained.release };
}

function retainedSharingReads(database: SessionEntryCacheDatabase | string, sessionKey: string) {
  const identity =
    typeof database === "string" ? database : findOpenClawAgentDatabaseIdentity(database)?.identity;
  return typeof identity === "string"
    ? preparedSharingReads.get(`file:${identity}\0${sessionKey}`)
    : undefined;
}
function stageSessionSharingPublication(database: SessionEntryCacheDatabase, sessionKey: string) {
  const releaseIncognito = !database.db.location()
    ? stageIncognitoSharingPublication(database.db, sessionKey)
    : undefined;
  const reads = [...(retainedSharingReads(database, sessionKey) ?? [])];
  const token = {};
  for (const read of reads) {
    read.pending.add(token);
  }
  return () => {
    releaseIncognito?.();
    for (const read of reads) {
      read.pending.delete(token);
    }
  };
}

function publishSessionSharingFieldChange(
  database: SessionEntryCacheDatabase & { path: string },
  sessionKey: string,
  change: Extract<SessionRowFacts, { kind: "member" | "owner" }>,
): void {
  publishTrackedCacheUpdate(
    database,
    () => {
      for (const read of retainedSharingReads(database, sessionKey) ?? []) {
        if (read.acquisition) {
          if (change.kind === "member") {
            recordAcquiringSessionMember(read.acquisition, change);
          } else {
            // A pending worker snapshot cannot establish which assignment it read.
            recordAcquiringSessionEntry(read.acquisition, undefined, undefined);
          }
        } else if (read.facts) {
          read.facts = updateSessionSharingField(read.facts, change);
        }
      }
      commitIncognitoSessionSharingField(database.db, sessionKey, change);
    },
    () => stageSessionSharingPublication(database, sessionKey),
  );
}

export function publishSessionSharingMemberChange(
  database: SessionEntryCacheDatabase & { path: string },
  sessionKey: string,
  member: Extract<SessionRowFacts, { kind: "member" }>,
  agentId = database.agentId,
): void {
  publishSessionSharingFieldChange(database, sessionKey, member);
  emitPreparedSessionSharingChange(database, sessionKey, agentId, member);
}
/** Publish sharing state before the listing projection and its public change event. */
export function publishSessionSharingEntryChange(
  database: SessionEntryCacheDatabase & { path: string },
  update: {
    sessionKey: string;
    entry?: SessionEntry;
    previousEntry?: Pick<SessionEntry, "sessionId" | "lifecycleRevision">;
    facts?: SessionRowFacts;
  },
): void {
  const facts = update.facts;
  if (facts?.kind === "owner") {
    publishSessionSharingFieldChange(database, update.sessionKey, facts);
    return;
  }
  const sharingUnchanged =
    facts?.kind === "unchanged" || facts?.kind === "participants" || facts?.kind === "category";
  const incognito = !database.db.location();
  const sharingEntry = update.entry ? projectSessionSharingEntry(update.entry) : undefined;
  const previousIdentity = update.previousEntry && {
    sessionId: update.previousEntry.sessionId,
    lifecycleRevision: update.previousEntry.lifecycleRevision,
  };
  if (!sharingUnchanged) {
    publishTrackedCacheUpdate(
      database,
      () => {
        publishRetainedSessionEntryChange(
          database,
          update.sessionKey,
          sharingEntry,
          previousIdentity,
          sharingEntry !== undefined || facts?.kind === "removed",
        );
      },
      !incognito ? () => stageSessionSharingPublication(database, update.sessionKey) : undefined,
    );
  }
  if (incognito && !sharingUnchanged) {
    publishIncognitoSessionEntryChange(database, update);
  }
}

function publishRetainedSessionEntryChange(
  database: SessionEntryCacheDatabase | string,
  sessionKey: string,
  entry: SessionSharingEntry | undefined,
  previousIdentity: Pick<SessionSharingEntry, "sessionId" | "lifecycleRevision"> | undefined,
  known: boolean,
): void {
  recordCommittedSessionEntryPublication(database, sessionKey, entry);
  for (const read of retainedSharingReads(database, sessionKey) ?? []) {
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

/** A confirmed worker result invalidates row facts without opening a parent connection. */
export function publishSessionEntryWorkerInvalidations(
  params: {
    agentId: string;
    storePath: string;
    databaseIdentity: string;
    removedSessionKeys?: ReadonlySet<string>;
  },
  changedKeys: readonly string[],
  beforePublicNotifications?: () => void,
): void {
  const keys = [...new Set(changedKeys)];
  const changes: SessionRowChange[] = [];
  for (const sessionKey of keys) {
    // Confirmed absence revokes a generation; other incomplete postimages remain unavailable.
    publishRetainedSessionEntryChange(
      params.databaseIdentity,
      sessionKey,
      undefined,
      undefined,
      params.removedSessionKeys?.has(sessionKey) === true,
    );
    const change: SessionRowChange = {
      agentId: params.agentId,
      storePath: params.storePath,
      sessionKey,
      factsInvalidated: true,
    };
    preparedSharingChanges.changes.set(change, undefined);
    changes.push(change);
  }
  if (keys.length > 0) {
    invalidateOpenClawAgentWritableProjections(params.databaseIdentity, (database) =>
      sessionEntryCaches.delete(database),
    );
    invalidateOpenClawAgentReadOnlyProjections(params.databaseIdentity, (database) =>
      sessionEntryCaches.delete(database),
    );
  }
  sessionChanges.emitBatch(changes, undefined, beforePublicNotifications);
}

/** Final-grant custody fences old facts until native settlement, independently of result delivery. */
export function retainSessionEntryWorkerPublication(params: {
  agentId: string;
  storePath: string;
  databaseIdentity: string;
}) {
  const creation = preparedSharingChanges.current.getStore();
  const owner: PendingSessionEntryPublication = {
    superseded: new Map(),
    membershipInvalidated: new Set(),
    settled: false,
  };
  let keys: string[] = [];
  const identityKey = `file:${params.databaseIdentity}`;
  let pending = false;
  return {
    begin(sessionKeys: readonly string[], membershipInvalidatedKeys: readonly string[]) {
      if (pending) {
        return;
      }
      keys = [...new Set(sessionKeys)];
      owner.membershipInvalidated = new Set(membershipInvalidatedKeys);
      pending = true;
      for (const sessionKey of keys) {
        const key = `${identityKey}\0${sessionKey}`;
        const owners = pendingSessionEntryPublications.get(key) ?? new Set();
        owners.add(owner);
        pendingSessionEntryPublications.set(key, owners);
      }
    },
    settle(
      receipt:
        | SessionEntryReplacementPublication
        | SessionTranscriptInitializationPublication
        | undefined,
      unknown: boolean,
    ) {
      if (!pending) {
        return undefined;
      }
      const replacement = receipt?.kind === "session-entry-replacements" ? receipt : undefined;
      const initialization =
        receipt?.kind === "session-transcript-initialized" ? receipt : undefined;
      const current = (sessionKey: string) => !owner.superseded.has(sessionKey);
      const currentIdentity = (sessionKey: string) => {
        if (current(sessionKey)) {
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
      };
      // A later native metadata write cannot restore membership omitted by an alias move.
      const membershipInvalidated = new Set(
        replacement
          ? replacement.membershipInvalidatedKeys.filter(currentIdentity)
          : unknown
            ? owner.membershipInvalidated
            : [],
      );
      const changed = [
        ...new Set([
          ...(
            replacement?.changedKeys ??
            (initialization?.placeholder ? [initialization.sessionKey] : unknown ? keys : [])
          ).filter(current),
          ...membershipInvalidated,
        ]),
      ];
      if (changed.length) {
        invalidateOpenClawAgentWritableProjections(params.databaseIdentity, (database) =>
          sessionEntryCaches.delete(database),
        );
        invalidateOpenClawAgentReadOnlyProjections(params.databaseIdentity, (database) =>
          sessionEntryCaches.delete(database),
        );
      }
      const changes: SessionRowChange[] = [];
      for (const sessionKey of changed) {
        const sharingEntry = replacement?.current.get(sessionKey);
        const placeholder =
          initialization?.sessionKey === sessionKey ? initialization.placeholder : undefined;
        const creationSource = creation?.source;
        const ownsCreation =
          creation?.active &&
          creationSource?.kind === "file" &&
          creationSource.databaseIdentity === params.databaseIdentity &&
          creationSource.agentId === params.agentId &&
          creation.sessionKey === sessionKey;
        for (const read of preparedSharingReads.get(`${identityKey}\0${sessionKey}`) ?? []) {
          recordAcquiringSessionEntry(
            read.acquisition,
            !unknown && !membershipInvalidated.has(sessionKey) ? sharingEntry : undefined,
            replacement?.previous.get(sessionKey),
          );
          publishRetainedSessionGeneration(
            read,
            sharingEntry,
            replacement !== undefined || placeholder !== undefined,
          );
          const previous = read.facts;
          read.facts = placeholder
            ? { entry: undefined, placeholder, membership: new Set() }
            : !membershipInvalidated.has(sessionKey) &&
                sharingEntry &&
                previous?.entry &&
                previous.entry.sessionId === sharingEntry.sessionId &&
                previous.entry.lifecycleRevision === sharingEntry.lifecycleRevision
              ? { entry: sharingEntry, membership: previous.membership }
              : undefined;
        }
        const change: SessionRowChange = {
          agentId: params.agentId,
          storePath: ownsCreation ? creationSource.path : params.storePath,
          sessionKey,
          factsInvalidated: true,
          ...(receipt && !unknown ? { scope: "session-entry" as const } : {}),
        };
        if (receipt) {
          // A COMMIT receipt can survive unknown settlement without retaining creation custody.
          preparedSharingChanges.changes.set(
            change,
            !unknown && placeholder && ownsCreation
              ? {
                  creation,
                  databaseIdentity: params.databaseIdentity,
                  sessionKey,
                  placeholder,
                  committed: true,
                }
              : undefined,
          );
        }
        changes.push(change);
      }
      owner.settled = true;
      try {
        sessionChanges.emitBatch(changes);
        return replacement
          ? {
              previous: new Map([...replacement.previous].filter(([key]) => currentIdentity(key))),
              current: new Map([...replacement.current].filter(([key]) => currentIdentity(key))),
            }
          : undefined;
      } finally {
        for (const sessionKey of keys) {
          const key = `${identityKey}\0${sessionKey}`;
          const owners = pendingSessionEntryPublications.get(key);
          owners?.delete(owner);
          if (owners?.size === 0) {
            pendingSessionEntryPublications.delete(key);
          }
        }
        pending = false;
      }
    },
  };
}
