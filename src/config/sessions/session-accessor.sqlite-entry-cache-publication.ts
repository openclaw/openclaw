import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import {
  sessionChanges,
  type SessionRowChange,
  type SessionRowFacts,
} from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { findOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { invalidateOpenClawAgentWritableProjections } from "../../state/openclaw-agent-db-lifecycle.js";
import { invalidateOpenClawAgentReadOnlyProjections } from "../../state/openclaw-agent-db-readonly-scope.js";
import {
  pendingSessionEntryPublications,
  preparedSharingReads,
  recordCommittedSessionEntryPublication,
  recordCommittedSessionMetadataPublication,
  retainedSharingReads,
} from "./session-accessor.sqlite-entry-cache-publication-state.js";
import {
  publishTrackedCacheUpdate,
  sessionEntryCaches,
} from "./session-accessor.sqlite-entry-cache-state.js";
import {
  createSessionEntryCreationOperation,
  projectSessionSharingEntry,
  readSessionEntryCreationIdentity,
  type SessionEntryCacheDatabase,
  type CreationDatabase,
  type CreationRecord,
  type PendingSessionEntryPublication,
  type PlaceholderReceipt,
  type SessionEntryPublicationRecord,
  type PreparedSessionEntryChanges,
  type SessionEntryReplacementPublication,
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
import { publishSessionEntryMaintenanceAgeChanges } from "./session-accessor.sqlite-maintenance-age.js";
import {
  publishRetainedSessionGeneration,
  updateSessionSharingField,
  recordAcquiringSessionEntry,
  recordAcquiringSessionMember,
  type CommittedSessionSharingFacts,
} from "./session-accessor.sqlite-sharing-acquisition.js";
import type { SessionEntry } from "./types.js";

export type {
  PreparedSessionEntryChanges,
  SessionEntryPublicationSource,
  SessionEntryReplacementPublication,
} from "./session-accessor.sqlite-entry-cache.types.js";

const preparedSharingChanges = resolveGlobalSingleton(
  Symbol.for("openclaw.preparedSessionSharingChanges"),
  () => ({
    changes: new WeakMap<object, SessionEntryPublicationRecord>(),
    operations: new WeakMap<SessionEntryCreationOperation, CreationRecord>(),
    current: new AsyncLocalStorage<CreationRecord>(),
  }),
);

/** Private owner metadata follows the original event object without changing its public fields. */
export function isPreparedSessionSharingChange(change: SessionRowChange): boolean {
  return preparedSharingChanges.changes.has(change);
}

export function readPreparedSessionSharingChange(change: object) {
  return preparedSharingChanges.changes.get(change)?.sharingChange;
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
  };
}

export function bindPreparedSessionEntryPublication(
  change: object,
  record: SessionEntryPublicationRecord,
): void {
  preparedSharingChanges.changes.set(change, record);
}

export function emitPreparedSessionSharingChange(
  database: SessionEntryCacheDatabase & { path: string },
  sessionKey: string,
  agentId = database.agentId,
  facts?: SessionRowFacts,
  record: SessionEntryPublicationRecord = { kind: "marker", sharingChange: "changed" },
): void {
  const change: SessionRowChange = {
    agentId,
    storePath: database.path,
    sessionKey,
    ...(facts ? { facts, scope: "session-entry" as const } : { factsInvalidated: true }),
  };
  bindPreparedSessionEntryPublication(change, record);
  sessionChanges.emit(change, database.db);
}

function invalidateSessionEntryCaches(databaseIdentity: string): void {
  invalidateOpenClawAgentWritableProjections(databaseIdentity, (database) =>
    sessionEntryCaches.delete(database),
  );
  invalidateOpenClawAgentReadOnlyProjections(databaseIdentity, (database) =>
    sessionEntryCaches.delete(database),
  );
}

/** A committed metadata-only worker write invalidates caches without changing retained identity. */
export function publishSessionEntryWorkerMetadataInvalidation(params: {
  agentId: string;
  storePath: string;
  databaseIdentity: string;
  sessionKey: string;
}): void {
  invalidateSessionEntryCaches(params.databaseIdentity);
  const change: SessionRowChange = {
    agentId: params.agentId,
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    scope: "session-entry",
    facts: { kind: "unchanged" },
  };
  bindPreparedSessionEntryPublication(change, { kind: "marker", sharingChange: "unchanged" });
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
  target: {
    agentId: string;
    sessionKey: string;
    paths: ReadonlySet<string>;
    databaseIdentity?: string;
  },
): void {
  const creation = preparedSharingChanges.operations.get(operation);
  assertCreationCurrent(creation);
  const sourcePath =
    creation.source.kind === "native" ? creation.source.database.path : creation.source.path;
  const matchesDatabaseIdentity =
    creation.source.kind === "file" &&
    target.databaseIdentity === `file:${creation.source.databaseIdentity}`;
  const matchesTarget =
    target.databaseIdentity !== undefined
      ? matchesDatabaseIdentity
      : target.paths.has(path.resolve(sourcePath));
  if (
    creation.agentId !== target.agentId ||
    creation.sessionKey !== target.sessionKey ||
    !matchesTarget
  ) {
    throw new Error("Session creation publication owner is no longer current");
  }
}

export function readSessionEntryCreationTransition(
  change: SessionRowChange,
  operation: SessionEntryCreationOperation,
): SessionEntryPlaceholder | undefined {
  const record = preparedSharingChanges.changes.get(change);
  const receipt = record?.kind === "placeholder" ? record.receipt : undefined;
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
    receipt.databaseIdentity === readSessionEntryCreationIdentity(creation) &&
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
    databaseIdentity: creation ? readSessionEntryCreationIdentity(creation) : database.db,
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
  emitPreparedSessionSharingChange(database, sessionKey, database.agentId, undefined, {
    kind: "placeholder",
    sharingChange: "changed",
    receipt,
  });
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
      if (change.kind === "owner") {
        const identity = findOpenClawAgentDatabaseIdentity(database)?.identity;
        if (typeof identity === "string") {
          for (const pending of pendingSessionEntryPublications.get(
            `file:${identity}\0${sessionKey}`,
          ) ?? []) {
            // A field update supersedes its value, not the pending entry's generation fence.
            pending.ownerChanges.set(sessionKey, structuredClone(change));
          }
        }
      }
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
  if (sharingUnchanged) {
    publishTrackedCacheUpdate(database, () =>
      recordCommittedSessionMetadataPublication(database, update.sessionKey),
    );
  }
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
    bindPreparedSessionEntryPublication(change, { kind: "marker", sharingChange: "changed" });
    changes.push(change);
  }
  if (keys.length > 0) {
    invalidateSessionEntryCaches(params.databaseIdentity);
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
  const completion = createDeferredCore();
  const owner: PendingSessionEntryPublication = {
    superseded: new Map(),
    metadataSuperseded: new Set(),
    ownerChanges: new Map(),
    membershipInvalidated: new Set(),
    sharingUnchanged: new Set(),
    settled: false,
    completion: completion.promise,
  };
  let keys: string[] = [];
  const identityKey = `file:${params.databaseIdentity}`;
  let pending = false;
  return {
    begin(
      sessionKeys: readonly string[],
      membershipInvalidatedKeys: readonly string[],
      sharingUnchangedKeys: readonly string[] = [],
    ) {
      if (pending) {
        return;
      }
      keys = [...new Set(sessionKeys)];
      owner.membershipInvalidated = new Set(membershipInvalidatedKeys);
      owner.sharingUnchanged = new Set(sharingUnchangedKeys);
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
      let replacement = receipt?.kind === "session-entry-replacements" ? receipt : undefined;
      if (replacement && owner.ownerChanges.size > 0) {
        const current = new Map(replacement.current);
        for (const [sessionKey, change] of owner.ownerChanges) {
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
        replacement = { ...replacement, current };
      }
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
        invalidateSessionEntryCaches(params.databaseIdentity);
      }
      const changes: SessionRowChange[] = [];
      const sharingUnchanged = new Set(replacement?.sharingUnchangedKeys);
      const prepared: PreparedSessionEntryChanges | undefined =
        replacement?.source?.identity === params.databaseIdentity
          ? {
              source: replacement.source,
              entries: new Map<string, SessionEntry>(
                [...replacement.current]
                  .filter(([key]) => current(key) && !owner.metadataSuperseded.has(key))
                  .map(([key, entry]) => [key, freezeJsonSnapshot(entry)]),
              ),
              sharing: new Map(
                [...replacement.current]
                  .filter(([key]) => current(key))
                  .map(([key, entry]) => [key, projectSessionSharingEntry(entry)]),
              ),
            }
          : undefined;
      for (const sessionKey of changed) {
        const entry = replacement?.current.get(sessionKey);
        const sharingEntry = entry ? projectSessionSharingEntry(entry) : undefined;
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
          ...(replacement?.previous.has(sessionKey) && !replacement.current.has(sessionKey)
            ? { facts: { kind: "removed" } as const }
            : { factsInvalidated: true as const }),
          ...(receipt && !unknown ? { scope: "session-entry" as const } : {}),
        };
        if (receipt) {
          // A COMMIT receipt can survive unknown settlement without retaining creation custody.
          const sharingChange =
            !membershipInvalidated.has(sessionKey) && sharingUnchanged.has(sessionKey)
              ? "unchanged"
              : "changed";
          bindPreparedSessionEntryPublication(
            change,
            !unknown && placeholder && ownsCreation
              ? {
                  kind: "placeholder",
                  sharingChange: "changed",
                  receipt: {
                    creation,
                    databaseIdentity: params.databaseIdentity,
                    sessionKey,
                    placeholder,
                    committed: true,
                  },
                }
              : prepared &&
                  (replacement?.previous.has(sessionKey) || replacement?.current.has(sessionKey))
                ? { kind: "metadata", sharingChange, prepared }
                : { kind: "marker", sharingChange },
          );
        }
        changes.push(change);
      }
      owner.settled = true;
      try {
        if (replacement) {
          publishSessionEntryMaintenanceAgeChanges(
            params.databaseIdentity,
            replacement.ageChanges.filter(
              ({ sessionKey }) => current(sessionKey) && !owner.metadataSuperseded.has(sessionKey),
            ),
          );
        }
        sessionChanges.emitBatch(changes);
        return replacement
          ? {
              previous: new Map([...replacement.previous].filter(([key]) => currentIdentity(key))),
              current: new Map([...replacement.current].filter(([key]) => currentIdentity(key))),
              prepared,
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
        completion.resolve();
      }
    },
  };
}
