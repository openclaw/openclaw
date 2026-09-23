import type { DatabaseSync } from "node:sqlite";
import { toUSVString } from "node:util";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import {
  sessionChanges,
  type SessionRowChange,
  type SessionRowFacts,
} from "../../sessions/session-row-changes.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { findOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { invalidateOpenClawAgentWritableProjections } from "../../state/openclaw-agent-db-lifecycle.js";
import { readOpenClawAgentDatabase } from "../../state/openclaw-agent-db-readonly-open.js";
import { invalidateOpenClawAgentReadOnlyProjections } from "../../state/openclaw-agent-db-readonly-scope.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { ExactSessionEntry } from "./session-accessor.sqlite-contract.js";
import {
  loadSessionEntrySnapshot,
  projectSessionEntryCacheUpdate,
  readSessionEntrySideMetadata,
  type SessionEntryCacheDatabase,
  type SessionEntrySideMetadata,
} from "./session-accessor.sqlite-entry-cache-projection.js";
import type {
  SessionEntryCacheSnapshot,
  SessionSharingEntry,
} from "./session-accessor.sqlite-entry-cache.types.js";
import {
  prepareExactSessionEntryRowReads,
  readExactSessionEntryRow,
  validateDeliveryCanonicalSessionEntry,
} from "./session-accessor.sqlite-entry-read.js";
import {
  cacheValidityTokensEqual,
  readSessionEntryCacheValidityToken,
  readSessionNodesGeneration,
  type SqliteSessionEntryRevision,
} from "./session-accessor.sqlite-entry-revision.js";
import { readSqliteSessionParticipantProjection } from "./session-accessor.sqlite-participant-projection.js";
import type { SessionEntryReadScope } from "./session-accessor.types.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";
import type { InternalSessionEntry, SessionEntry } from "./types.js";

type SessionEntryCacheTables = Pick<OpenClawAgentKyselyDatabase, "session_nodes">;

type SqliteSessionEntryCache = SessionEntryCacheSnapshot & {
  validityToken: SqliteSessionEntryRevision;
};

type SqliteSessionEntryCacheWriteGeneration = {
  after: number;
  before: number;
};

// Retain listing metadata only; complete prompt snapshots belong to the caller's full read.
// Weak connection ownership lets closed read-only and evicted database handles release their
// snapshots. The connection-local validity token plus tracked-write invalidation keeps live
// snapshots current; narrow tracked upserts patch one authoritative row after commit, while
// structural/unknown writes invalidate. Without both, every read would re-query and re-parse
// every entry_json document.
const sessionEntryCaches = new WeakMap<DatabaseSync, SqliteSessionEntryCache>();

type CommittedSessionSharingFacts = { entry: SessionSharingEntry; membership: ReadonlySet<string> };

export type SessionEntryReplacementPublication = {
  kind: "session-entry-replacements";
  previous: Map<string, Pick<SessionEntry, "sessionId" | "lifecycleRevision">>;
  current: Map<string, SessionSharingEntry>;
  changedKeys: string[];
  membershipInvalidatedKeys: string[];
};

type PreparedSessionSharingRead = {
  facts: { entry: SessionSharingEntry | undefined; membership: ReadonlySet<string> } | undefined;
};
const preparedSharingReads = resolveGlobalSingleton(
  Symbol.for("openclaw.preparedSessionSharingReads"),
  () => new Map<string, Set<PreparedSessionSharingRead>>(),
);
const preparedSharingChanges = resolveGlobalSingleton(
  Symbol.for("openclaw.preparedSessionSharingChanges"),
  () => new WeakSet<SessionRowChange>(),
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
  return preparedSharingChanges.has(change);
}

function emitPreparedSessionSharingChange(
  database: SessionEntryCacheDatabase & { path: string },
  sessionKey: string,
  agentId = database.agentId,
  facts?: SessionRowFacts,
): void {
  const change: SessionRowChange = {
    agentId,
    storePath: database.path,
    sessionKey,
    ...(facts ? { facts } : { factsInvalidated: true }),
  };
  preparedSharingChanges.add(change);
  sessionChanges.emit(change, database.db);
}

export function projectSessionSharingEntry(entry: SessionEntry): SessionSharingEntry {
  return {
    sessionId: entry.sessionId,
    updatedAt: entry.updatedAt,
    lifecycleRevision: entry.lifecycleRevision,
    visibility: entry.visibility,
    incognito: entry.incognito,
    createdActor: entry.createdActor ? { ...entry.createdActor } : undefined,
    sandbox: entry.sandbox,
  };
}

/** The existing entry writer advances retained facts before any commit observer can reenter. */
export function retainPreparedSessionSharingFacts(params: {
  databaseIdentity: string;
  sessionKey: string;
  entry: SessionSharingEntry | undefined;
  membership: ReadonlySet<string>;
}) {
  const key = `${params.databaseIdentity}\0${params.sessionKey}`;
  const read: PreparedSessionSharingRead = {
    facts: { entry: params.entry, membership: params.membership },
  };
  const reads = preparedSharingReads.get(key) ?? new Set<PreparedSessionSharingRead>();
  reads.add(read);
  preparedSharingReads.set(key, reads);
  let active = true;
  return {
    readCurrent: () =>
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

function retainedSharingReads(database: SessionEntryCacheDatabase, sessionKey: string) {
  const identity = findOpenClawAgentDatabaseIdentity(database)?.identity;
  return typeof identity === "string"
    ? preparedSharingReads.get(`file:${identity}\0${sessionKey}`)
    : undefined;
}
// Process-held stores cannot be reopened in a worker. Their existing writer publishes
// only sharing fields, bounded by live entries and the native database's lifetime.
const incognitoSharingEntries = resolveGlobalSingleton(
  Symbol.for("openclaw.incognitoSessionSharingEntries"),
  () => new WeakMap<DatabaseSync, Map<string, CommittedSessionSharingFacts>>(),
);

export function readCommittedIncognitoSessionSharing(database: DatabaseSync, sessionKey: string) {
  return incognitoSharingEntries.get(database)?.get(sessionKey);
}

export function publishSessionSharingMemberChange(
  database: SessionEntryCacheDatabase & { path: string },
  sessionKey: string,
  member: Extract<SessionRowFacts, { kind: "member" }>,
  agentId = database.agentId,
): void {
  publishTrackedCacheUpdate(database, () => {
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
    if (!database.db.location()) {
      const current = incognitoSharingEntries.get(database.db)?.get(sessionKey);
      if (current) {
        incognitoSharingEntries.get(database.db)?.set(sessionKey, update(current));
      }
    }
  });
  emitPreparedSessionSharingChange(database, sessionKey, agentId, member);
}
/** Commit-driven projections borrow owner memory; ordinary reads still validate SQLite. */
export function readCommittedSessionEntryCache(database: DatabaseSync) {
  return sessionEntryCaches.get(database)?.entries;
}

/** A settled worker with an unknown write outcome cannot publish a trustworthy field patch. */
export function discardCommittedSessionEntryCache(database: DatabaseSync): void {
  sessionEntryCaches.delete(database);
}

/** Reuse only complete, current metadata; exact reads still own misses and invalid rows. */
function readCachedExactSessionEntries(
  database: SessionEntryCacheDatabase,
  sessionKeys: readonly string[],
): Map<string, SessionEntry> | undefined {
  const cached = sessionEntryCaches.get(database.db);
  if (!cached || database.db.isTransaction) {
    return undefined;
  }
  const keys = [...new Set(sessionKeys.map(toUSVString))];
  if (keys.some((key) => !cached.entries.has(key))) {
    return undefined;
  }
  const validityToken = cached.validityToken;
  try {
    if (!cacheValidityTokensEqual(validityToken, readSessionEntryCacheValidityToken(database.db))) {
      return undefined;
    }
    // List snapshots do not retain these columns; matching generations alone
    // cannot prove exact identity after a raw edit followed by a list reload.
    const rows = executeSqliteQuerySync(
      database.db,
      getNodeSqliteKysely<SessionEntryCacheTables>(database.db)
        .selectFrom("session_nodes")
        .select(["session_key", "current_session_id", "updated_at"])
        .where("session_key", "in", sqliteStringSet(keys)),
    ).rows;
    if (rows.length !== keys.length) {
      return undefined;
    }
    const rowsByKey = new Map(rows.map((row) => [row.session_key, row]));
    const entries = new Map<string, SessionEntry>();
    for (const sessionKey of new Set(sessionKeys)) {
      const key = toUSVString(sessionKey);
      const row = rowsByKey.get(key);
      const entry = cached.entries.get(key);
      if (
        !row ||
        !entry ||
        entry.sessionId !== row.current_session_id ||
        entry.updatedAt !== row.updated_at
      ) {
        return undefined;
      }
      // Distinct raw strings may bind to the same native key, but exact batches
      // give each raw request its own entry while sharing repeated identical keys.
      entries.set(sessionKey, validateDeliveryCanonicalSessionEntry(key, structuredClone(entry)));
    }
    return sessionEntryCaches.get(database.db) === cached &&
      cacheValidityTokensEqual(validityToken, readSessionEntryCacheValidityToken(database.db))
      ? entries
      : undefined;
  } catch {
    // Cohort conversion/validation failures retain the exact reader's per-key errors.
    return undefined;
  }
}

/** Decode one admitted physical store without changing exact per-request error isolation. */
export function readExactSessionEntryCandidatesInDatabase(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  requests: readonly (readonly string[])[],
  projection: SessionEntryReadScope["projection"],
): Array<Result<ExactSessionEntry[], unknown>> {
  const entries = new Map<string, Result<ExactSessionEntry | undefined, unknown>>();
  const keys = [...new Set(requests.flat())];
  const cachedEntries =
    projection === "list" ? readCachedExactSessionEntries(database, keys) : undefined;
  let readPrepared: (sessionKey: string) => InternalSessionEntry | undefined;
  if (cachedEntries) {
    readPrepared = (sessionKey) => cachedEntries.get(sessionKey);
  } else {
    const readRows = prepareExactSessionEntryRowReads(database, keys, projection);
    readPrepared = (sessionKey) => readRows(sessionKey)?.entry;
  }
  const readEntry = (sessionKey: string): Result<ExactSessionEntry | undefined, unknown> => {
    const cached = entries.get(sessionKey);
    if (cached) {
      return cached;
    }
    let result: Result<ExactSessionEntry | undefined, unknown>;
    try {
      const entry = readOpenClawAgentDatabase(database, () => readPrepared(sessionKey)).value;
      result = ok(entry ? { sessionKey, entry } : undefined);
    } catch (error) {
      result = err(error);
    }
    entries.set(sessionKey, result);
    return result;
  };
  return requests.map((sessionKeys) => {
    const matches: ExactSessionEntry[] = [];
    for (const sessionKey of sessionKeys) {
      const entry = readEntry(sessionKey);
      if (!entry.ok) {
        return err(entry.error);
      }
      if (entry.value) {
        matches.push(entry.value);
      }
    }
    return ok(matches);
  });
}

/** Bracket one accessor-owned row write so its publication cannot hide earlier raw DML. */
export function trackSessionEntryCacheWrite(
  database: OpenClawAgentDatabase,
  write: () => void,
): SqliteSessionEntryCacheWriteGeneration | undefined {
  const before = sessionEntryCaches.has(database.db)
    ? readSessionNodesGeneration(database.db)
    : undefined;
  write();
  if (before === undefined) {
    return undefined;
  }
  const generation = { before, after: readSessionNodesGeneration(database.db) };
  return generation;
}

export function readSessionEntryCache(
  database: SessionEntryCacheDatabase,
  options: {
    cache: boolean;
    latest?: boolean;
    projection?: "full" | "list";
    /** Uncached mixed snapshot: retain complete selected rows beside sibling metadata. */
    fullEntryKeys?: readonly string[];
    /** Stream full JSON once, retaining prompt snapshots only for selected rows. Never cached. */
    retainFullEntry?: (sessionKey: string, entry: SessionEntry) => boolean;
    /** Topology admits metadata first; its worker owns participant hydration. Never cache this view. */
    deferParticipants?: true;
  },
): SessionEntryCacheSnapshot {
  const projection = options.retainFullEntry ? "full" : options.projection;
  const prepared = assertCanonicalSqliteSessionKeysCurrent(
    database,
    projection !== "full" && !options.fullEntryKeys,
  );
  if (
    !options.cache ||
    options.deferParticipants ||
    options.fullEntryKeys ||
    options.retainFullEntry ||
    options.latest ||
    projection === "full" ||
    database.db.isTransaction
  ) {
    return loadSessionEntrySnapshot(
      database,
      projection,
      prepared,
      options.fullEntryKeys ? new Set(options.fullEntryKeys) : undefined,
      options.retainFullEntry,
      options.deferParticipants,
    );
  }
  const validityToken = readSessionEntryCacheValidityToken(database.db, "cached");
  const cached = sessionEntryCaches.get(database.db);
  if (cached && cacheValidityTokensEqual(cached.validityToken, validityToken)) {
    return cached;
  }
  // Only tracked publications identify changed rows. A generation gap can contain
  // same-timestamp or owner-only edits; updated_at cannot validate a partial reload.
  const loaded = loadSessionEntrySnapshot(database, options.projection, prepared);
  const next = { ...loaded, validityToken };
  sessionEntryCaches.set(database.db, next);
  return next;
}

function publishTrackedCacheUpdate(database: SessionEntryCacheDatabase, publish: () => void): void {
  // Committed cache state must settle before observers can reenter with newer writes.
  if (
    stageSqliteTransactionState(database.db, {
      stage: () => {},
      rollback: () => {},
      commit: publish,
    })
  ) {
    return;
  }
  if (database.db.isTransaction) {
    throw new Error(
      "SQLite session entry writes must use runOpenClawAgentWriteTransaction for cache publication",
    );
  }
  publish();
}

function advanceSessionEntryCacheGeneration(
  cached: SqliteSessionEntryCache,
  writeGeneration: SqliteSessionEntryCacheWriteGeneration,
): void {
  // Advance only across the bracketed row write. A raw write before/after this bracket leaves
  // a generation gap, while the retained data_version still exposes external commits.
  if (cached.validityToken.sessionNodesGeneration === writeGeneration.before) {
    cached.validityToken = {
      ...cached.validityToken,
      sessionNodesGeneration: writeGeneration.after,
    };
  }
}

function publishSqliteSessionEntryCacheUpsert(
  database: SessionEntryCacheDatabase,
  update: { sessionKey: string; entry?: SessionEntry },
  writeGeneration: SqliteSessionEntryCacheWriteGeneration,
): SessionEntrySideMetadata | undefined {
  const owner = sessionEntryCaches.get(database.db);
  if (!owner) {
    return undefined;
  }
  const { sessionKey } = update;
  let sideMetadata: SessionEntrySideMetadata | undefined;
  let entry: SessionEntry | undefined;
  try {
    sideMetadata = readSessionEntrySideMetadata(database, sessionKey);
    entry = update.entry ? projectSessionEntryCacheUpdate(update.entry, sideMetadata) : undefined;
  } catch {
    // A failed derived projection must not roll back an authoritative write.
    publishTrackedCacheUpdate(database, () => sessionEntryCaches.delete(database.db));
    return undefined;
  }
  publishTrackedCacheUpdate(database, () => {
    const cached = sessionEntryCaches.get(database.db);
    if (!cached) {
      return;
    }
    // Borrowed cache views are synchronous, so the commit owner can update one
    // row in place without cloning every session map on each active-run write.
    let publishedEntry = entry;
    const currentEntry = cached.entries.get(sessionKey);
    if (!update.entry && currentEntry && sideMetadata) {
      // Earlier publications in this transaction may have replaced the entry itself.
      const {
        owner: _owner,
        participants: _participants,
        participantCount: _count,
        ...metadata
      } = currentEntry;
      publishedEntry = { ...metadata, ...sideMetadata };
    }
    if (!publishedEntry) {
      sessionEntryCaches.delete(database.db);
      return;
    }
    if (!cached.entries.has(sessionKey) && !cached.keys.includes(sessionKey)) {
      cached.keys = [...cached.keys, sessionKey].toSorted();
    }
    cached.entries.set(sessionKey, publishedEntry);
    advanceSessionEntryCacheGeneration(cached, writeGeneration);
  });
  return sideMetadata;
}

export function publishSessionEntryCacheInvalidation(
  database: SessionEntryCacheDatabase & { path: string },
  update: { sessionKey: string; entry?: SessionEntry; facts?: SessionRowFacts },
  writeGeneration?: SqliteSessionEntryCacheWriteGeneration,
): void {
  let facts = update.facts;
  const sharingUnchanged =
    facts?.kind === "unchanged" || facts?.kind === "participants" || facts?.kind === "category";
  const incognito = !database.db.location();
  const sharingEntry = update.entry ? projectSessionSharingEntry(update.entry) : undefined;
  if (!sharingUnchanged) {
    publishTrackedCacheUpdate(database, () => {
      recordCommittedSessionEntryPublication(database, update.sessionKey, sharingEntry);
      for (const read of retainedSharingReads(database, update.sessionKey) ?? []) {
        const previous = read.facts;
        read.facts =
          sharingEntry &&
          previous?.entry &&
          previous.entry.sessionId === sharingEntry.sessionId &&
          previous.entry.lifecycleRevision === sharingEntry.lifecycleRevision
            ? { entry: sharingEntry, membership: previous.membership }
            : undefined;
      }
    });
  }
  if (incognito && !sharingUnchanged) {
    let current: CommittedSessionSharingFacts | undefined;
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
      // Failed projection cannot undo its writer; prepared authorization remains unavailable.
    }
    publishTrackedCacheUpdate(database, () => {
      let entries = incognitoSharingEntries.get(database.db);
      if (!entries && current) {
        entries = new Map();
        incognitoSharingEntries.set(database.db, entries);
      }
      if (current) {
        entries?.set(update.sessionKey, current);
      } else {
        entries?.delete(update.sessionKey);
      }
    });
  }
  if (writeGeneration) {
    const metadata = publishSqliteSessionEntryCacheUpsert(database, update, writeGeneration);
    if (facts?.kind === "participants" && metadata) {
      facts = {
        kind: "participants",
        projection: {
          participants: metadata.participants,
          participantCount: metadata.participantCount,
        },
      };
    }
  } else {
    // A cold write has no snapshot to patch; do not hydrate owner/participants or prompt JSON.
    publishTrackedCacheUpdate(database, () => sessionEntryCaches.delete(database.db));
  }
  emitPreparedSessionSharingChange(database, update.sessionKey, database.agentId, facts);
}

/** The category worker publishes only its changed field; native freshness tokens still expose other commits. */
export function publishSessionEntryCacheCategoryUpdate(
  database: SessionEntryCacheDatabase,
  rows: ReadonlyArray<{ sessionKey: string; sessionId: string }>,
  category: string | undefined,
): void {
  publishTrackedCacheUpdate(database, () => {
    const cached = sessionEntryCaches.get(database.db);
    for (const { sessionKey, sessionId } of rows) {
      const current = cached?.entries.get(sessionKey);
      if (!current || current.sessionId !== sessionId) {
        continue;
      }
      const next = { ...current };
      if (category === undefined) {
        delete next.category;
      } else {
        next.category = category;
      }
      cached?.entries.set(sessionKey, next);
    }
  });
}

/** Final-grant custody fences old facts until native settlement, independently of result delivery. */
export function retainSessionEntryWorkerPublication(params: {
  agentId: string;
  storePath: string;
  databaseIdentity: string;
}) {
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
    settle(receipt: SessionEntryReplacementPublication | undefined, unknown: boolean) {
      if (!pending) {
        return undefined;
      }
      const current = (sessionKey: string) => !owner.superseded.has(sessionKey);
      const currentIdentity = (sessionKey: string) => {
        if (current(sessionKey)) {
          return true;
        }
        const native = owner.superseded.get(sessionKey);
        const committed = receipt?.current.get(sessionKey);
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
        receipt
          ? receipt.membershipInvalidatedKeys.filter(currentIdentity)
          : unknown
            ? owner.membershipInvalidated
            : [],
      );
      const changed = [
        ...new Set([
          ...(receipt?.changedKeys ?? (unknown ? keys : [])).filter(current),
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
        const sharingEntry = receipt?.current.get(sessionKey);
        for (const read of preparedSharingReads.get(`${identityKey}\0${sessionKey}`) ?? []) {
          const previous = read.facts;
          read.facts =
            !membershipInvalidated.has(sessionKey) &&
            sharingEntry &&
            previous?.entry &&
            previous.entry.sessionId === sharingEntry.sessionId &&
            previous.entry.lifecycleRevision === sharingEntry.lifecycleRevision
              ? { entry: sharingEntry, membership: previous.membership }
              : undefined;
        }
        const change: SessionRowChange = {
          agentId: params.agentId,
          storePath: params.storePath,
          sessionKey,
          factsInvalidated: true,
        };
        if (receipt) {
          preparedSharingChanges.add(change);
        }
        changes.push(change);
      }
      owner.settled = true;
      try {
        sessionChanges.emitBatch(changes);
        return receipt
          ? {
              previous: new Map([...receipt.previous].filter(([key]) => currentIdentity(key))),
              current: new Map([...receipt.current].filter(([key]) => currentIdentity(key))),
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

/** Refresh participant projections without reloading unchanged session-entry JSON. */
export function publishSessionEntryCacheParticipantUpdate(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  params: {
    writeGeneration: SqliteSessionEntryCacheWriteGeneration | undefined;
    projectionChanged: boolean;
  },
): void {
  const { writeGeneration, projectionChanged } = params;
  if (!projectionChanged) {
    // Count-only contributions do not change list facts, including when the cache is cold.
    if (writeGeneration) {
      publishTrackedCacheUpdate(database, () => {
        const cached = sessionEntryCaches.get(database.db);
        if (cached) {
          advanceSessionEntryCacheGeneration(cached, writeGeneration);
        }
      });
    }
    return;
  }
  let facts: SessionRowFacts = { kind: "participants" };
  if (!writeGeneration) {
    try {
      facts = {
        kind: "participants",
        projection: readSqliteSessionParticipantProjection(database.db, sessionKey),
      };
    } catch {
      // Invalid derived facts require reconciliation without rolling back the recorded write.
    }
  }
  publishSessionEntryCacheInvalidation(database, { sessionKey, facts }, writeGeneration);
}
