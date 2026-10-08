import {
  sessionChanges,
  type SessionRowChange,
  type SessionRowFacts,
} from "../../sessions/session-row-changes.js";
import { readSessionTranscriptUpdateVersion } from "../../sessions/transcript-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { findOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { invalidateOpenClawAgentWritableProjections } from "../../state/openclaw-agent-db-lifecycle.js";
import { invalidateOpenClawAgentReadOnlyProjections } from "../../state/openclaw-agent-db-readonly-scope.js";
import {
  applyPendingSessionEntryOwnerChanges,
  isSessionEntryReplacementIdentityCurrent,
  pendingSessionEntryPublications,
  prepareSessionEntryReplacementChanges,
  preparedSharingReads,
  publishRetainedSessionEntryChange,
  readCurrentSessionEntryProjection,
  recordCommittedSessionEntryPublication,
  recordCommittedSessionMetadataPublication,
  recordCommittedSessionOwnerPublication,
  retainedSharingReads,
  stageSessionSharingPublication,
  preparedSharingChanges,
} from "./session-accessor.sqlite-entry-cache-publication-state.js";
import {
  publishTrackedCacheUpdate,
  sessionEntryCaches,
} from "./session-accessor.sqlite-entry-cache-state.js";
import {
  createSessionEntryCreationOperation,
  assertSessionEntryCreationCurrent,
  assertSessionEntryCreationTarget,
  type SessionEntryCreationTarget,
  projectSessionSharingEntry,
  readSessionEntryCreationIdentity,
  type SessionEntryCacheDatabase,
  type CreationDatabase,
  type CreationRecord,
  type PendingSessionEntryPublication,
  type PlaceholderReceipt,
  type SessionEntryPublicationRecord,
  type SessionEntryReplacementPublication,
  type SessionEntryCreationOperation,
  type SessionEntryPlaceholder,
  type SessionTranscriptInitializationPublication,
} from "./session-accessor.sqlite-entry-cache.types.js";
import {
  commitIncognitoSessionSharingFacts,
  commitIncognitoSessionSharingField,
  publishIncognitoSessionEntryChange,
} from "./session-accessor.sqlite-incognito-sharing.js";
import { publishSessionEntryMaintenanceAgeChanges } from "./session-accessor.sqlite-maintenance-age.js";
import {
  projectSessionEntryPredicateChange,
  publishRetainedSessionEntryPredicate,
  publishRetainedSessionGeneration,
  revokePreparedSessionEntryPredicate,
  updateSessionSharingField,
  recordAcquiringSessionEntry,
  recordAcquiringSessionMember,
  type CommittedSessionSharingFacts,
} from "./session-accessor.sqlite-sharing-acquisition.js";
import type { SessionEntry } from "./types.js";

export {
  isPreparedSessionSharingChange,
  readPreparedSessionEntryChange,
  readPreparedSessionEntryPublicationSource,
  readPreparedSessionSharingChange,
} from "./session-accessor.sqlite-entry-cache-publication-state.js";
export type {
  PreparedSessionEntryChanges,
  SessionEntryPublicationSource,
  SessionEntryReplacementPublication,
} from "./session-accessor.sqlite-entry-cache.types.js";

export function bindPreparedSessionEntryPublication(
  change: object,
  record: SessionEntryPublicationRecord,
): void {
  preparedSharingChanges.changes.set(change, record);
}

export function bindSessionEntryPublicationSource<T extends SessionRowChange>(
  change: T,
  database: SessionEntryCacheDatabase,
): T {
  const source = findOpenClawAgentDatabaseIdentity(database);
  if (source) {
    bindPreparedSessionEntryPublication(change, {
      ...(preparedSharingChanges.changes.get(change) ?? { kind: "source" }),
      databaseIdentity: source.identity,
      canonicalPath: source.canonicalPath,
    });
  }
  return change;
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
  bindSessionEntryPublicationSource(change, database);
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
  for (const read of retainedSharingReads(params.databaseIdentity, params.sessionKey) ?? []) {
    publishRetainedSessionEntryPredicate(read, undefined, false);
  }
  const change: SessionRowChange = {
    agentId: params.agentId,
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    scope: "session-entry",
    facts: { kind: "unchanged" },
  };
  bindPreparedSessionEntryPublication(change, {
    kind: "marker",
    sharingChange: "unchanged",
    databaseIdentity: params.databaseIdentity,
  });
  sessionChanges.emit(change);
}

function creationMatchesDatabase(creation: CreationRecord, database: SessionEntryCacheDatabase) {
  return creation.source.kind === "native"
    ? creation.source.database.db === database.db
    : creation.source.kind === "file" &&
        creation.source.agentId === database.agentId &&
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
    | {
        database?: never;
        file: Omit<Exclude<CreationDatabase, { kind: "native" }>, "kind"> & {
          kind?: "file" | "actor";
        };
      }
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
  assertSessionEntryCreationCurrent(creation);
  return preparedSharingChanges.current.run(creation, run);
}

export function assertSessionEntryCreationPublication(
  operation: SessionEntryCreationOperation,
  target: SessionEntryCreationTarget,
): void {
  assertSessionEntryCreationTarget(preparedSharingChanges.operations.get(operation), target);
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
    assertSessionEntryCreationCurrent(creation);
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
        revokePreparedSessionEntryPredicate(read);
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

function publishSessionSharingFieldChange(
  database: SessionEntryCacheDatabase & { path: string },
  sessionKey: string,
  change: Extract<SessionRowFacts, { kind: "member" | "owner" }>,
): void {
  publishTrackedCacheUpdate(
    database,
    () => {
      if (change.kind === "owner") {
        recordCommittedSessionOwnerPublication(database, sessionKey, change);
      } else {
        const identity = findOpenClawAgentDatabaseIdentity(database)?.identity;
        if (typeof identity === "string") {
          for (const pending of pendingSessionEntryPublications.get(
            `file:${identity}\0${sessionKey}`,
          ) ?? []) {
            // The delayed entry postimage predates this membership publication.
            pending.projectionSuperseded.add(sessionKey);
          }
        }
      }
      for (const read of retainedSharingReads(database, sessionKey) ?? []) {
        if (change.kind === "owner" && read.predicate) {
          const entry = projectSessionEntryPredicateChange(read.predicate, change);
          publishRetainedSessionEntryPredicate(read, entry, entry !== undefined);
        }
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
    () => stageSessionSharingPublication(database, sessionKey, change),
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
      recordCommittedSessionMetadataPublication(database, update.sessionKey, facts, update.entry),
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
          update.entry,
        );
      },
      !incognito ? () => stageSessionSharingPublication(database, update.sessionKey) : undefined,
    );
  }
  if (incognito && !sharingUnchanged) {
    publishIncognitoSessionEntryChange(database, update);
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
    bindPreparedSessionEntryPublication(change, {
      kind: "marker",
      sharingChange: "changed",
      databaseIdentity: params.databaseIdentity,
    });
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
    projectionSuperseded: new Set(),
    ownerChanges: new Map(),
    membershipInvalidated: new Set(),
    sharingUnchanged: new Set(),
    generationUnchanged: new Set(),
    settled: false,
    completion: completion.promise,
  };
  let keys: string[] = [];
  const identityKey = `file:${params.databaseIdentity}`;
  let pending = false;
  let transcriptVersion: number | undefined;
  return {
    begin(
      sessionKeys: readonly string[],
      membershipInvalidatedKeys: readonly string[],
      sharingUnchangedKeys: readonly string[] = [],
      generationUnchangedKeys: readonly string[] = [],
    ) {
      if (pending) {
        return;
      }
      keys = [...new Set(sessionKeys)];
      transcriptVersion = readSessionTranscriptUpdateVersion();
      owner.membershipInvalidated = new Set(membershipInvalidatedKeys);
      owner.sharingUnchanged = new Set(sharingUnchangedKeys);
      owner.generationUnchanged = new Set(generationUnchangedKeys);
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
      const replacement = applyPendingSessionEntryOwnerChanges(
        receipt?.kind === "session-entry-replacements" ? receipt : undefined,
        owner.ownerChanges,
      );
      const initialization =
        receipt?.kind === "session-transcript-initialized" ? receipt : undefined;
      const current = (sessionKey: string) => !owner.superseded.has(sessionKey);
      const currentIdentity = (sessionKey: string) =>
        isSessionEntryReplacementIdentityCurrent(owner, replacement, sessionKey);
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
      const supersededMembership = replacement
        ? replacement.changedKeys.filter(
            (key) =>
              owner.superseded.get(key) !== undefined &&
              replacement.projection?.has(key) &&
              !changed.includes(key),
          )
        : [];
      if (changed.length || supersededMembership.length) {
        invalidateSessionEntryCaches(params.databaseIdentity);
      }
      const changes: SessionRowChange[] = [];
      const sharingUnchanged = new Set(replacement?.sharingUnchangedKeys);
      const transcriptUnchanged = transcriptVersion === readSessionTranscriptUpdateVersion();
      const prepared =
        !unknown && replacement
          ? prepareSessionEntryReplacementChanges(
              owner,
              replacement,
              params.databaseIdentity,
              transcriptUnchanged,
            )
          : undefined;
      for (const sessionKey of changed) {
        const entry = replacement?.current.get(sessionKey);
        const projection = prepared?.projection?.get(sessionKey);
        // A later transcript append retires its display watermark, not committed sharing facts.
        const sharingProjection =
          prepared && readCurrentSessionEntryProjection(owner, replacement, sessionKey);
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
          if (placeholder) {
            revokePreparedSessionEntryPredicate(read);
          } else if (current(sessionKey) && !owner.metadataSuperseded.has(sessionKey)) {
            publishRetainedSessionEntryPredicate(
              read,
              entry,
              !unknown && replacement !== undefined,
            );
          }
          recordAcquiringSessionEntry(
            read.acquisition,
            sharingProjection ? sharingEntry : undefined,
            replacement?.previous.get(sessionKey),
          );
          publishRetainedSessionGeneration(
            read,
            sharingEntry,
            !unknown && (replacement !== undefined || placeholder !== undefined),
          );
          const previous = read.facts;
          read.facts =
            !unknown && placeholder
              ? { entry: undefined, placeholder, membership: new Set() }
              : !unknown &&
                  sharingProjection &&
                  sharingEntry &&
                  previous?.entry &&
                  previous.entry.sessionId === sharingEntry.sessionId &&
                  previous.entry.lifecycleRevision === sharingEntry.lifecycleRevision
                ? {
                    entry: sharingEntry,
                    membership: new Set(sharingProjection.membership[2]),
                  }
                : undefined;
        }
        const change: SessionRowChange = {
          agentId: params.agentId,
          storePath: ownsCreation ? creationSource.path : params.storePath,
          sessionKey,
          ...(!unknown &&
          replacement?.previous.has(sessionKey) &&
          !replacement.current.has(sessionKey)
            ? { facts: { kind: "removed" } as const }
            : projection
              ? { facts: { kind: "replacement", membership: projection.membership } as const }
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
                  databaseIdentity: params.databaseIdentity,
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
                : { kind: "marker", sharingChange, databaseIdentity: params.databaseIdentity },
          );
        } else {
          bindPreparedSessionEntryPublication(change, {
            kind: "source",
            databaseIdentity: params.databaseIdentity,
          });
        }
        changes.push(change);
      }
      for (const sessionKey of supersededMembership) {
        // The newer native row owns its metadata, but its delta cannot certify the
        // worker's complete membership snapshot. Retain its exact generation while
        // reconciling membership through the existing projection owner.
        for (const read of preparedSharingReads.get(`${identityKey}\0${sessionKey}`) ?? []) {
          read.facts = undefined;
          recordAcquiringSessionEntry(read.acquisition, undefined, undefined);
        }
        const change: SessionRowChange = {
          agentId: params.agentId,
          storePath: params.storePath,
          sessionKey,
          scope: "session-entry",
          factsInvalidated: true,
        };
        bindPreparedSessionEntryPublication(change, {
          kind: "marker",
          sharingChange: "unchanged",
          databaseIdentity: params.databaseIdentity,
        });
        changes.push(change);
      }
      // Unknown successors also retire older facts; a late receipt cannot resolve their outcome.
      for (const sessionKey of changed) {
        recordCommittedSessionEntryPublication(
          params.databaseIdentity,
          sessionKey,
          undefined,
          owner,
        );
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
