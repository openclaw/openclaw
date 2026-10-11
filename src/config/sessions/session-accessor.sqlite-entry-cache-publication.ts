import {
  sessionChanges,
  type SessionRowChange,
  type SessionRowFacts,
} from "../../sessions/session-row-changes.js";
import { findOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { invalidateOpenClawAgentWritableProjections } from "../../state/openclaw-agent-db-lifecycle.js";
import { invalidateOpenClawAgentReadOnlyProjections } from "../../state/openclaw-agent-db-readonly-scope.js";
import {
  publishRetainedSessionEntryChange,
  recordCommittedSessionEntryPublication,
  recordCommittedSessionMetadataPublication,
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
  type PlaceholderReceipt,
  type SessionEntryPublicationRecord,
  type SessionEntryCreationOperation,
} from "./session-accessor.sqlite-entry-cache.types.js";
import {
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

export function invalidateSessionEntryCaches(databaseIdentity: string): void {
  invalidateOpenClawAgentWritableProjections(databaseIdentity, (database) =>
    sessionEntryCaches.delete(database),
  );
  invalidateOpenClawAgentReadOnlyProjections(databaseIdentity, (database) =>
    sessionEntryCaches.delete(database),
  );
}

/** Retire all facts in a failed installation, including pending older worker receipts. */
export function invalidateSessionEntryPublication(
  database: SessionEntryCacheDatabase,
  sessionKey: string,
): void {
  publishRetainedSessionEntryChange(database, sessionKey, undefined, undefined, false);
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
    kind: "placeholder",
    creation,
    databaseIdentity: creation ? readSessionEntryCreationIdentity(creation) : database.db,
    sessionKey,
    placeholder,
    committed: false,
  };
  let staged = false;
  staged = publishTrackedCacheUpdate(
    database,
    () => {
      recordCommittedSessionEntryPublication(database, sessionKey);
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
      sessionEntryCaches.delete(database.db);
      receipt.committed = staged;
    },
    () => stageSessionSharingPublication(database, sessionKey),
    () => invalidateSessionEntryPublication(database, sessionKey),
  );
  emitPreparedSessionSharingChange(database, sessionKey, database.agentId, undefined, {
    kind: "placeholder",
    sharingChange: "changed",
    receipt,
  });
}

export function publishSessionSharingFieldChange(
  database: SessionEntryCacheDatabase,
  sessionKey: string,
  change: Extract<SessionRowFacts, { kind: "member" | "owner" | "category" }>,
): void {
  publishTrackedCacheUpdate(
    database,
    () => {
      // A newer write invalidates a delayed cache receipt; the next read reloads it.
      recordCommittedSessionMetadataPublication(database, sessionKey, change);
      for (const read of retainedSharingReads(database, sessionKey) ?? []) {
        if (read.acquisition) {
          if (change.kind === "member") {
            recordAcquiringSessionMember(read.acquisition, change);
          } else {
            // A pending worker snapshot cannot establish which field assignment it read.
            recordAcquiringSessionEntry(read.acquisition, undefined, undefined);
          }
        } else if (read.facts) {
          read.facts = updateSessionSharingField(read.facts, change);
        }
      }
    },
    () =>
      stageSessionSharingPublication(
        database,
        sessionKey,
        change.kind === "category" ? undefined : change,
      ),
    () => invalidateSessionEntryPublication(database, sessionKey),
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
  if (facts?.kind === "owner" || facts?.kind === "category") {
    publishSessionSharingFieldChange(database, update.sessionKey, facts);
    return;
  }
  const sharingUnchanged = facts?.kind === "unchanged" || facts?.kind === "participants";
  const sharingEntry = update.entry ? projectSessionSharingEntry(update.entry) : undefined;
  if (sharingUnchanged) {
    publishTrackedCacheUpdate(
      database,
      () =>
        recordCommittedSessionMetadataPublication(database, update.sessionKey, facts, update.entry),
      undefined,
      () => invalidateSessionEntryPublication(database, update.sessionKey),
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
      () => stageSessionSharingPublication(database, update.sessionKey),
      () => invalidateSessionEntryPublication(database, update.sessionKey),
    );
  }
}
