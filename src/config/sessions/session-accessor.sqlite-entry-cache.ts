import type { DatabaseSync } from "node:sqlite";
import { toUSVString } from "node:util";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { readSqliteDataVersion } from "../../infra/node-sqlite.js";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { ExactSessionEntry } from "./session-accessor.sqlite-contract.js";
import {
  prepareExactSessionEntryRowReads,
  validateDeliveryCanonicalSessionEntry,
} from "./session-accessor.sqlite-entry-read.js";
import type { SqliteSessionEntryRevision } from "./session-accessor.sqlite-entry-revision.js";
import {
  hasSqliteSessionOwnerColumns,
  readSqliteSessionOwner,
} from "./session-accessor.sqlite-owner-projection.js";
import {
  projectSqliteSessionParticipantsBatch,
  readSqliteSessionParticipantProjection,
} from "./session-accessor.sqlite-participant-projection.js";
import { parseSessionEntryJson, selectSessionEntryRows } from "./session-accessor.sqlite-status.js";
import type { SessionEntryReadScope } from "./session-accessor.types.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  type ValidatedSessionMetadata,
} from "./session-canonical-key.js";
import type { InternalSessionEntry, SessionEntry } from "./types.js";

type SessionEntryCacheTables = Pick<OpenClawAgentKyselyDatabase, "session_nodes">;

type SessionEntryCacheDatabase = Pick<OpenClawAgentDatabase, "agentId" | "db">;

export type SessionEntryCacheSnapshot = {
  entries: Map<string, SessionEntry>;
  keys: string[];
};

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
/** Commit-driven projections borrow owner memory; ordinary reads still validate SQLite. */
export function readCommittedSessionEntryCache(database: DatabaseSync) {
  return sessionEntryCaches.get(database)?.entries;
}
const sessionNodesGenerationTrackerSchemaVersions = new WeakMap<DatabaseSync, number>();

function ensureSessionNodesGenerationTracker(database: DatabaseSync): void {
  const schemaRow = database.prepare("PRAGMA schema_version").get() as {
    schema_version?: unknown;
  };
  if (typeof schemaRow.schema_version !== "number") {
    throw new Error("SQLite did not return a numeric PRAGMA schema_version");
  }
  const trackedSchemaVersion = sessionNodesGenerationTrackerSchemaVersions.get(database);
  if (trackedSchemaVersion === schemaRow.schema_version) {
    return;
  }
  const hasParticipants = tableExists(database, "session_participants");
  // sqlite-allow-raw -- TEMP triggers are the connection-local ownership boundary: they
  // observe unpublished raw DML. A main-schema change bumps the generation before reinstalling
  // them, so dropping/recreating session_nodes cannot make an old snapshot look current.
  database.exec(`
    CREATE TEMP TABLE IF NOT EXISTS openclaw_session_nodes_cache_generation (id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL) STRICT;
    INSERT OR IGNORE INTO openclaw_session_nodes_cache_generation (id, generation) VALUES (1, 0);
    ${trackedSchemaVersion === undefined ? "" : "UPDATE openclaw_session_nodes_cache_generation SET generation = generation + 1 WHERE id = 1;"}
    DROP TRIGGER IF EXISTS openclaw_session_nodes_cache_generation_insert;
    DROP TRIGGER IF EXISTS openclaw_session_nodes_cache_generation_update;
    DROP TRIGGER IF EXISTS openclaw_session_nodes_cache_generation_delete;
    CREATE TEMP TRIGGER openclaw_session_nodes_cache_generation_insert
      AFTER INSERT ON main.session_nodes BEGIN UPDATE openclaw_session_nodes_cache_generation SET generation = generation + 1 WHERE id = 1; END;
    CREATE TEMP TRIGGER openclaw_session_nodes_cache_generation_update
      AFTER UPDATE ON main.session_nodes BEGIN UPDATE openclaw_session_nodes_cache_generation SET generation = generation + 1 WHERE id = 1; END;
    CREATE TEMP TRIGGER openclaw_session_nodes_cache_generation_delete
      AFTER DELETE ON main.session_nodes BEGIN UPDATE openclaw_session_nodes_cache_generation SET generation = generation + 1 WHERE id = 1; END;
    DROP TRIGGER IF EXISTS openclaw_session_participants_cache_generation_insert;
    DROP TRIGGER IF EXISTS openclaw_session_participants_cache_generation_update;
    DROP TRIGGER IF EXISTS openclaw_session_participants_cache_generation_delete;
    ${
      hasParticipants
        ? `
    CREATE TEMP TRIGGER openclaw_session_participants_cache_generation_insert
      AFTER INSERT ON main.session_participants BEGIN UPDATE openclaw_session_nodes_cache_generation SET generation = generation + 1 WHERE id = 1; END;
    CREATE TEMP TRIGGER openclaw_session_participants_cache_generation_update
      AFTER UPDATE ON main.session_participants BEGIN UPDATE openclaw_session_nodes_cache_generation SET generation = generation + 1 WHERE id = 1; END;
    CREATE TEMP TRIGGER openclaw_session_participants_cache_generation_delete
      AFTER DELETE ON main.session_participants BEGIN UPDATE openclaw_session_nodes_cache_generation SET generation = generation + 1 WHERE id = 1; END;
    `
        : ""
    }
  `);
  // A rolled-back schema change can reuse its version on retry after SQLite removes the triggers.
  if (!database.isTransaction) {
    sessionNodesGenerationTrackerSchemaVersions.set(database, schemaRow.schema_version);
  } else {
    const version = schemaRow.schema_version;
    stageSqliteTransactionState(database, {
      stage: () => sessionNodesGenerationTrackerSchemaVersions.set(database, version),
      rollback: () => sessionNodesGenerationTrackerSchemaVersions.delete(database),
      commit: () => {},
    });
  }
}

function readSessionNodesGeneration(database: DatabaseSync): number {
  ensureSessionNodesGenerationTracker(database);
  const row = database
    .prepare("SELECT generation FROM temp.openclaw_session_nodes_cache_generation WHERE id = 1")
    .get() as { generation?: unknown };
  if (typeof row.generation !== "number") {
    throw new Error("SQLite session_nodes cache generation is unavailable");
  }
  return row.generation;
}

function readSessionEntryCacheValidityToken(database: DatabaseSync): SqliteSessionEntryRevision {
  return {
    dataVersion: readSqliteDataVersion(database),
    sessionNodesGeneration: readSessionNodesGeneration(database),
  };
}

function cacheValidityTokensEqual(
  left: SqliteSessionEntryRevision,
  right: SqliteSessionEntryRevision,
): boolean {
  return (
    left.dataVersion === right.dataVersion &&
    left.sessionNodesGeneration === right.sessionNodesGeneration
  );
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
      const entry = readPrepared(sessionKey);
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

function loadSessionEntrySnapshot(
  database: SessionEntryCacheDatabase,
  projection: "full" | "list" = "list",
  prepared?: ValidatedSessionMetadata,
  fullEntryKeys?: ReadonlySet<string>,
): SessionEntryCacheSnapshot {
  // Validation lends complete parsed facts only within this read. A concurrent external commit
  // requires the ordinary fresh SELECT, never a stale snapshot stamped with its newer version.
  const metadata =
    !fullEntryKeys && prepared && prepared.dataVersion === readSqliteDataVersion(database.db)
      ? prepared
      : undefined;
  const parsedEntries = metadata?.entries ?? new Map<string, SessionEntry>();
  const keys = metadata?.keys ?? [];
  // Stream raw JSON so a full read never holds both serialized and parsed store-wide payloads.
  if (!metadata) {
    for (const row of iterateSqliteQuerySync(
      database.db,
      selectSessionEntryRows(database, projection, fullEntryKeys ? [...fullEntryKeys] : [])
        .select("updated_at")
        .orderBy("session_key"),
    )) {
      keys.push(row.session_key);
      const entry = parseSessionEntryJson(
        row,
        fullEntryKeys?.has(row.session_key) ? "full" : projection,
      );
      if (entry) {
        parsedEntries.set(row.session_key, entry);
      }
    }
  }
  const entries = projectSqliteSessionParticipantsBatch(database.db, parsedEntries);
  return {
    entries,
    keys,
  };
}

export function readSessionEntryCache(
  database: SessionEntryCacheDatabase,
  options: {
    cache: boolean;
    latest?: boolean;
    projection?: "full" | "list";
    /** Uncached mixed snapshot: retain complete selected rows beside sibling metadata. */
    fullEntryKeys?: readonly string[];
  },
): SessionEntryCacheSnapshot {
  const prepared = assertCanonicalSqliteSessionKeysCurrent(
    database,
    undefined,
    options.projection !== "full" && !options.fullEntryKeys,
  );
  if (
    !options.cache ||
    options.fullEntryKeys ||
    options.latest ||
    options.projection === "full" ||
    database.db.isTransaction
  ) {
    return loadSessionEntrySnapshot(
      database,
      options.projection,
      prepared,
      options.fullEntryKeys ? new Set(options.fullEntryKeys) : undefined,
    );
  }
  const validityToken = readSessionEntryCacheValidityToken(database.db);
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

type SessionEntrySideMetadata = Pick<SessionEntry, "owner" | "participants" | "participantCount">;

function readSessionEntrySideMetadata(
  database: SessionEntryCacheDatabase,
  sessionKey: string,
): SessionEntrySideMetadata {
  const ownerRow = hasSqliteSessionOwnerColumns(database.db)
    ? executeSqliteQuerySync(
        database.db,
        getNodeSqliteKysely<SessionEntryCacheTables>(database.db)
          .selectFrom("session_nodes")
          .select([
            "owner_actor_type",
            "owner_actor_id",
            "owner_assigned_by_type",
            "owner_assigned_by_id",
            "owner_assigned_at",
          ])
          .where("session_key", "=", sessionKey)
          .limit(1),
      ).rows[0]
    : undefined;
  const owner = ownerRow ? readSqliteSessionOwner(ownerRow) : undefined;
  return {
    ...(owner ? { owner } : {}),
    ...readSqliteSessionParticipantProjection(database.db, sessionKey),
  };
}

function projectSessionEntryCacheUpdate(
  sourceEntry: SessionEntry,
  sideMetadata: SessionEntrySideMetadata | undefined,
): SessionEntry | undefined {
  // Saved prompts are caller-owned and must never be serialized into the listing cache.
  const { skillsSnapshot: _skills, systemPromptReport: _report, ...metadata } = sourceEntry;
  const parsedEntry = parseSessionEntryJson({ entry_json: JSON.stringify(metadata) });
  return parsedEntry ? { ...parsedEntry, ...sideMetadata } : undefined;
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
): void {
  const owner = sessionEntryCaches.get(database.db);
  if (!owner) {
    return;
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
    return;
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
}

export function publishSessionEntryCacheInvalidation(
  database: SessionEntryCacheDatabase & { path: string },
  update?: { sessionKey: string; entry?: SessionEntry },
  writeGeneration?: SqliteSessionEntryCacheWriteGeneration,
): void {
  if (update && writeGeneration) {
    publishSqliteSessionEntryCacheUpsert(database, update, writeGeneration);
  } else {
    // A cold write has no snapshot to patch; do not hydrate owner/participants or prompt JSON.
    publishTrackedCacheUpdate(database, () => sessionEntryCaches.delete(database.db));
  }
  const scope = { agentId: database.agentId, storePath: database.path };
  sessionChanges.emit(
    update ? { ...scope, sessionKey: update.sessionKey } : { all: true, scope },
    database.db,
  );
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
  if (writeGeneration && !projectionChanged) {
    // Nested contributions advance the generation at commit without replacing borrowed entries.
    publishTrackedCacheUpdate(database, () => {
      const cached = sessionEntryCaches.get(database.db);
      if (cached) {
        advanceSessionEntryCacheGeneration(cached, writeGeneration);
      }
    });
    return;
  }
  publishSessionEntryCacheInvalidation(database, { sessionKey }, writeGeneration);
}
