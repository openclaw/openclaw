import type { DatabaseSync } from "node:sqlite";
import { toUSVString } from "node:util";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { readSqliteDataVersion } from "../../infra/node-sqlite.js";
import {
  getAdmittedSqliteSchemaFacts,
  runSqliteReadOperationSync,
} from "../../infra/sqlite-schema-facts.js";
import type { SessionRowFacts } from "../../sessions/session-row-changes.js";
import { readOpenClawAgentDatabase } from "../../state/openclaw-agent-db-readonly-open.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { ExactSessionEntry } from "./session-accessor.sqlite-contract.js";
import {
  loadSessionEntrySnapshot,
  projectSessionEntryCacheUpdate,
  readSessionEntrySideMetadata,
  type SessionEntrySideMetadata,
} from "./session-accessor.sqlite-entry-cache-projection.js";
import {
  emitPreparedSessionSharingChange,
  publishSessionSharingEntryChange,
} from "./session-accessor.sqlite-entry-cache-publication.js";
import {
  publishTrackedCacheUpdate,
  sessionEntryCaches,
  type SqliteSessionEntryCache,
} from "./session-accessor.sqlite-entry-cache-state.js";
import type {
  SessionEntryCacheDatabase,
  SessionEntryCacheReadOptions,
  SessionEntryCacheSnapshot,
} from "./session-accessor.sqlite-entry-cache.types.js";
import {
  prepareExactSessionEntryRowReads,
  validateDeliveryCanonicalSessionEntry,
} from "./session-accessor.sqlite-entry-read.js";
import {
  cacheValidityTokensEqual,
  readSessionEntryCacheValidityToken,
  readSessionNodesGeneration,
} from "./session-accessor.sqlite-entry-revision.js";
import { readSqliteSessionParticipantProjection } from "./session-accessor.sqlite-participant-projection.js";
import type { SessionEntryReadScope } from "./session-accessor.types.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";
import type { InternalSessionEntry, SessionEntry } from "./types.js";

export {
  assertSessionEntryCreationPublication,
  isPreparedSessionSharingChange,
  publishSessionEntryPlaceholderInsertion,
  publishSessionSharingMemberChange,
  readCommittedIncognitoSessionSharing,
  readSessionEntryCreationTransition,
  retainPreparedSessionGenerationFacts,
  retainPreparedSessionSharingFacts,
  retainSessionEntryWorkerPublication,
  withSessionEntryCreationPublication,
  runWithSessionEntryCreationPublication,
} from "./session-accessor.sqlite-entry-cache-publication.js";
export {
  projectSessionSharingEntry,
  type SessionEntryPlaceholder,
  type SessionEntryReplacementPublication,
  type SessionTranscriptInitializationPublication,
} from "./session-accessor.sqlite-entry-cache.types.js";

type SessionEntryCacheTables = Pick<OpenClawAgentKyselyDatabase, "session_nodes">;

type SqliteSessionEntryCacheWriteGeneration = {
  after: number;
  before: number;
};

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
    sessionEntryCaches.delete(database.db);
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
  const before =
    sessionEntryCaches.has(database.db) && getAdmittedSqliteSchemaFacts(database.db)
      ? readSessionNodesGeneration(database.db)
      : undefined;
  write();
  if (before === undefined || !getAdmittedSqliteSchemaFacts(database.db)) {
    sessionEntryCaches.delete(database.db);
    return undefined;
  }
  return { before, after: readSessionNodesGeneration(database.db) };
}

export function readSessionEntryCache(
  database: SessionEntryCacheDatabase,
  options: SessionEntryCacheReadOptions,
): SessionEntryCacheSnapshot {
  return runSqliteReadOperationSync(database.db, () => {
    const projection = options.retainFullEntry ? "full" : options.projection;
    const prepared = assertCanonicalSqliteSessionKeysCurrent(database, projection !== "full");
    if (
      !options.cache ||
      options.deferParticipants ||
      options.retainFullEntry ||
      options.latest ||
      projection === "full" ||
      database.db.isTransaction ||
      !getAdmittedSqliteSchemaFacts(database.db)
    ) {
      return loadSessionEntrySnapshot(
        database,
        projection,
        prepared,
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
  });
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
    // A tracked entry write leaves participants unchanged. Reuse only facts current
    // before that write; raw DML and foreign commits still force an authoritative read.
    const retained =
      update.entry &&
      owner.validityToken.sessionNodesGeneration === writeGeneration.before &&
      owner.validityToken.dataVersion === readSqliteDataVersion(database.db)
        ? owner.entries.get(sessionKey)
        : undefined;
    sideMetadata = readSessionEntrySideMetadata(
      database,
      sessionKey,
      retained
        ? { participants: retained.participants, participantCount: retained.participantCount }
        : undefined,
    );
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
  publishSessionSharingEntryChange(database, update);
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
