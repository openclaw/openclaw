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
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";
import type { SessionEntry } from "./types.js";

type CommittedSessionSharingFacts = {
  entry: SessionSharingEntry | undefined;
  placeholder?: SessionEntryPlaceholder;
  membership: ReadonlySet<string>;
};
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
  operation: SessionEntryCreationOperation;
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
  previous: Map<string, Pick<SessionEntry, "sessionId" | "lifecycleRevision">>;
  current: Map<string, SessionSharingEntry>;
  changedKeys: string[];
  membershipInvalidatedKeys: string[];
};

type PreparedSessionSharingRead = {
  pending: Set<object>;
  facts: CommittedSessionSharingFacts | undefined;
  generation?: {
    current: Pick<SessionEntry, "sessionId" | "lifecycleRevision"> | null | undefined;
  };
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
  database: SessionEntryCacheDatabase,
  sessionKey: string,
  entry: SessionSharingEntry | undefined,
): void {
  const identity = findOpenClawAgentDatabaseIdentity(database)?.identity;
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

function assertCreationCurrent(creation: CreationRecord): void {
  if (!creation.active) {
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
    operation,
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
  if (!creation) {
    throw new Error("Session creation publication owner is no longer current");
  }
  assertCreationCurrent(creation);
  return preparedSharingChanges.current.run(creation, run);
}

export function assertSessionEntryCreationPublication(
  operation: SessionEntryCreationOperation,
  target: { agentId: string; sessionKey: string; paths: ReadonlySet<string> },
): void {
  const creation = preparedSharingChanges.operations.get(operation);
  if (!creation) {
    throw new Error("Session creation publication owner is no longer current");
  }
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
        publishRetainedSessionGeneration(read, undefined, staged);
        read.facts = facts;
      }
      if (incognito) {
        incognitoSharingState(database.db).entries.set(sessionKey, facts ?? null);
      }
      sessionEntryCaches.delete(database.db);
      receipt.committed = staged;
    },
    () => stageSessionSharingPublication(database, sessionKey),
  );
  emitPreparedSessionSharingChange(database, sessionKey, database.agentId, undefined, receipt);
}

/** The existing entry writer advances retained facts before any commit observer can reenter. */
export function retainPreparedSessionSharingFacts(params: {
  databaseIdentity: string;
  sessionKey: string;
  entry: SessionSharingEntry | undefined;
  placeholder?: SessionEntryPlaceholder;
  membership: ReadonlySet<string>;
  generation?: PreparedSessionSharingRead["generation"];
}) {
  const key = `${params.databaseIdentity}\0${params.sessionKey}`;
  const read: PreparedSessionSharingRead = {
    pending: new Set(),
    facts: { entry: params.entry, placeholder: params.placeholder, membership: params.membership },
    generation: params.generation,
  };
  const reads = preparedSharingReads.get(key) ?? new Set<PreparedSessionSharingRead>();
  reads.add(read);
  preparedSharingReads.set(key, reads);
  let active = true;
  return {
    readGeneration: () =>
      read.pending.size > 0 ||
      [...(pendingSessionEntryPublications.get(key) ?? [])].some(
        (pending) => !pending.settled && !pending.superseded.has(params.sessionKey),
      )
        ? undefined
        : active
          ? read.generation?.current
          : undefined,
    readCurrent: () =>
      read.pending.size > 0 ||
      [...(pendingSessionEntryPublications.get(key) ?? [])].some(
        (pending) =>
          !pending.settled &&
          (!pending.superseded.has(params.sessionKey) ||
            pending.membershipInvalidated.has(params.sessionKey)),
      )
        ? undefined
        : read.facts,
    release: () => {
      if (!active) {
        return;
      }
      active = false;
      read.facts = undefined;
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
    generation: { current: params.entry ?? null },
  });
  return { readCurrent: retained.readGeneration, release: retained.release };
}

function publishRetainedSessionGeneration(
  read: PreparedSessionSharingRead,
  entry: SessionSharingEntry | undefined,
  known: boolean,
) {
  const generation = read.generation;
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

function retainedSharingReads(database: SessionEntryCacheDatabase, sessionKey: string) {
  const identity = findOpenClawAgentDatabaseIdentity(database)?.identity;
  return typeof identity === "string"
    ? preparedSharingReads.get(`file:${identity}\0${sessionKey}`)
    : undefined;
}
// Process-held stores cannot be reopened in a worker. Their existing writer publishes
// content-free metadata, bounded by live entries and the native database's lifetime.
const incognitoSharingEntries = resolveGlobalSingleton(
  Symbol.for("openclaw.incognitoSessionSharingEntries"),
  () =>
    new WeakMap<
      DatabaseSync,
      {
        entries: Map<string, CommittedSessionSharingFacts | null>;
        pending: Map<string, Set<object>>;
      }
    >(),
);

function incognitoSharingState(database: DatabaseSync) {
  let state = incognitoSharingEntries.get(database);
  if (!state) {
    state = { entries: new Map(), pending: new Map() };
    incognitoSharingEntries.set(database, state);
  }
  return state;
}

function stageIncognitoSharingPublication(database: DatabaseSync, sessionKey: string) {
  const state = incognitoSharingState(database);
  const token = {};
  const pending = state.pending.get(sessionKey) ?? new Set<object>();
  state.pending.set(sessionKey, pending);
  pending.add(token);
  return () => {
    pending.delete(token);
    if (pending.size === 0) {
      state.pending.delete(sessionKey);
    }
  };
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

export function readCommittedIncognitoSessionSharing(database: DatabaseSync, sessionKey: string) {
  const state = incognitoSharingEntries.get(database);
  if (state?.pending.has(sessionKey)) {
    throw new Error("Incognito session sharing publication is pending");
  }
  const current = state?.entries.get(sessionKey);
  if (current === null) {
    throw new Error("Incognito session sharing projection is unavailable");
  }
  return current;
}

export function publishSessionSharingMemberChange(
  database: SessionEntryCacheDatabase & { path: string },
  sessionKey: string,
  member: Extract<SessionRowFacts, { kind: "member" }>,
  agentId = database.agentId,
): void {
  const incognito = !database.db.location();
  publishTrackedCacheUpdate(
    database,
    () => {
      const update = <
        T extends { entry: SessionSharingEntry | undefined; membership: ReadonlySet<string> },
      >(
        facts: T,
      ): T => {
        // A legacy synchronous replacement can commit before a worker reply reaches this owner.
        if (facts.entry?.sessionId !== member.sessionId) {
          return facts;
        }
        const membership = new Set(facts.membership);
        if (member.present) {
          membership.add(member.identityId);
        } else {
          membership.delete(member.identityId);
        }
        return { ...facts, membership };
      };
      for (const read of retainedSharingReads(database, sessionKey) ?? []) {
        if (read.facts) {
          read.facts = update(read.facts);
        }
      }
      if (incognito) {
        const current = incognitoSharingEntries.get(database.db)?.entries.get(sessionKey);
        if (current) {
          incognitoSharingEntries.get(database.db)?.entries.set(sessionKey, update(current));
        }
      }
    },
    () => stageSessionSharingPublication(database, sessionKey),
  );
  emitPreparedSessionSharingChange(database, sessionKey, agentId, member);
}
/** Publish sharing state before the listing projection and its public change event. */
export function publishSessionSharingEntryChange(
  database: SessionEntryCacheDatabase & { path: string },
  update: { sessionKey: string; entry?: SessionEntry; facts?: SessionRowFacts },
): void {
  const facts = update.facts;
  const sharingUnchanged =
    facts?.kind === "unchanged" || facts?.kind === "participants" || facts?.kind === "category";
  const incognito = !database.db.location();
  const sharingEntry = update.entry ? projectSessionSharingEntry(update.entry) : undefined;
  if (!sharingUnchanged) {
    publishTrackedCacheUpdate(
      database,
      () => {
        recordCommittedSessionEntryPublication(database, update.sessionKey, sharingEntry);
        for (const read of retainedSharingReads(database, update.sessionKey) ?? []) {
          publishRetainedSessionGeneration(
            read,
            sharingEntry,
            sharingEntry !== undefined || facts?.kind === "removed",
          );
          const previous = read.facts;
          read.facts =
            sharingEntry &&
            previous?.entry &&
            previous.entry.sessionId === sharingEntry.sessionId &&
            previous.entry.lifecycleRevision === sharingEntry.lifecycleRevision
              ? { entry: sharingEntry, membership: previous.membership }
              : undefined;
        }
      },
      !incognito ? () => stageSessionSharingPublication(database, update.sessionKey) : undefined,
    );
  }
  if (incognito && !sharingUnchanged) {
    let current: CommittedSessionSharingFacts | null | undefined;
    try {
      const entry =
        update.entry ?? readExactSessionEntryRow(database, update.sessionKey, "list")?.entry;
      current = entry
        ? {
            entry: projectSessionSharingEntry(entry),
            membership: new Set(
              listSessionMembersInDatabase(database, update.sessionKey).map(
                (member) => member.identityId,
              ),
            ),
          }
        : undefined;
    } catch {
      // Failed projection cannot establish absence for a later creation attempt.
      current = null;
    }
    const state = incognitoSharingState(database.db);
    publishTrackedCacheUpdate(
      database,
      () => {
        const entries = state.entries;
        if (current !== undefined) {
          entries.set(update.sessionKey, current);
        } else {
          entries.delete(update.sessionKey);
        }
      },
      () => stageIncognitoSharingPublication(database.db, update.sessionKey),
    );
  }
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
          const ownedPlaceholder = !unknown && placeholder && ownsCreation;
          preparedSharingChanges.changes.set(
            change,
            ownedPlaceholder
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
