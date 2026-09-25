import type { DatabaseSync } from "node:sqlite";
import { readSqliteDataVersion } from "../../infra/node-sqlite.js";

/**
 * Connection-local memo for reference analysis over a bounded set of candidate
 * session ids.
 *
 * The reference predicate cannot be served from an index: it has to reach every
 * row that could hold an arbitrary reference (malformed JSON, raw invalid bytes,
 * `previousSessionId`, `usageFamilySessionIds`, `compactionCheckpoints`). So the
 * only way to keep a sweep's database work from growing with the candidate count
 * is to examine the store once for a batch of candidates and then prove, rather
 * than re-scan to discover, that the answer is still current at each later
 * boundary.
 *
 * The proof is a two-part connection-local token:
 *
 * - `PRAGMA data_version` changes whenever another connection commits, which is
 *   the only way an external writer can appear.
 * - A TEMP-table generation counter, bumped by TEMP triggers, observes writes on
 *   *this* connection, which `data_version` deliberately does not report.
 *
 * Both halves are connection-local in the strict sense: a reading is only
 * comparable against another reading from the *same* handle. A replacement
 * connection restarts `data_version` from its own baseline and opens an empty
 * TEMP schema whose counter begins at zero, so two readings taken across a
 * close and reopen can be equal even though another connection committed a
 * reference in between — the numbers reset rather than advance, which is
 * indistinguishable from nothing having happened. A batch therefore records the
 * handle that produced its token and is rebuilt on a replacement instead of
 * being trusted across one.
 *
 * The triggers count `INSERT` and `UPDATE` only. A `DELETE` can remove a
 * reference but never create one, so a memo taken before a delete stays
 * conservative: it may still claim a candidate is referenced when it no longer
 * is, which abandons a reclaim, and can never claim a referenced candidate is
 * free. That asymmetry is what lets a sweep delete its own candidates without
 * invalidating the batch it is working through.
 */
type SessionReferenceToken = {
  dataVersion: number;
  referenceGeneration: number;
};

type SessionReferenceBatch = {
  /**
   * The handle whose readings `token` is expressed in. Readings from any other
   * handle are not comparable against it, so the batch reprimes instead.
   */
  database: DatabaseSync;
  token: SessionReferenceToken;
  /** Ids the priming scan actually resolved; anything else falls back. */
  candidateSessionIds: ReadonlySet<string>;
  /** Up to `MAX_TRACKED_OWNERS_PER_ID` distinct keys holding each primed id. */
  ownersByCandidateSessionId: ReadonlyMap<string, ReadonlySet<string>>;
  /** Rebuilds the memo when the originating handle is replaced mid-batch. */
  prime: SessionReferencePrime;
};

/**
 * Two owners answer any single-key exclusion exactly: if two distinct keys hold
 * an id, excluding one still leaves it referenced, so further owners cannot
 * change the verdict. Requests excluding more keys than this fall back to a
 * fresh read rather than guessing.
 */
const MAX_TRACKED_OWNERS_PER_ID = 2;

// Keyed by database PATH, not the DatabaseSync object: a worker-coordinated
// operation (e.g. transcript archive publish) can release and reopen the
// cached connection for this exact path mid-sweep, producing a new
// DatabaseSync instance for the same logical database. Keying the map by the
// live connection object silently orphans the batch the moment that happens --
// every subsequent candidate in the same sweep sees `activeBatches.get()`
// return undefined and falls back to a full re-scan, defeating the batching
// this module exists to provide (confirmed empirically: identical dispatch
// counts to the archive-publish worker on both a working and a broken tree,
// but a `MISS (fresh open)` on the connection cache immediately follows
// every dispatch only on the tree where the batch gets lost).
//
// The path is only how a batch is FOUND. Whether it may be believed is a
// separate question that the entry answers itself, by carrying the handle its
// token came from: a replacement reprimes rather than inheriting a proof that
// cannot describe it.
const activeBatches = new Map<string, SessionReferenceBatch>();
const referenceTrackerSchemaVersions = new WeakMap<DatabaseSync, number>();

function ensureSessionReferenceTracker(database: DatabaseSync): void {
  const schemaRow = /* sqlite-allow-raw: pragma read has no Kysely form. */ database
    .prepare("PRAGMA schema_version")
    // node:sqlite hands back an untyped row record for a PRAGMA read.
    // SAFETY: the asserted shape types the column as `unknown`, so the assertion grants no value type; the `typeof` guard below is the only thing that admits it.
    .get() as { schema_version?: unknown };
  if (typeof schemaRow.schema_version !== "number") {
    throw new Error("SQLite did not return a numeric PRAGMA schema_version");
  }
  const trackedSchemaVersion = referenceTrackerSchemaVersions.get(database);
  if (trackedSchemaVersion === schemaRow.schema_version) {
    return;
  }
  // sqlite-allow-raw -- TEMP triggers are the connection-local ownership boundary and see
  // unpublished raw DML. A main-schema change bumps the generation before reinstalling them,
  // so dropping and recreating either table cannot make an older memo look current.
  database.exec(`
    CREATE TEMP TABLE IF NOT EXISTS openclaw_session_reference_generation (id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL) STRICT;
    INSERT OR IGNORE INTO openclaw_session_reference_generation (id, generation) VALUES (1, 0);
    ${trackedSchemaVersion === undefined ? "" : "UPDATE openclaw_session_reference_generation SET generation = generation + 1 WHERE id = 1;"}
    DROP TRIGGER IF EXISTS openclaw_session_reference_generation_node_insert;
    DROP TRIGGER IF EXISTS openclaw_session_reference_generation_node_update;
    DROP TRIGGER IF EXISTS openclaw_session_reference_generation_window_insert;
    DROP TRIGGER IF EXISTS openclaw_session_reference_generation_window_update;
    CREATE TEMP TRIGGER openclaw_session_reference_generation_node_insert
      AFTER INSERT ON main.session_nodes BEGIN UPDATE openclaw_session_reference_generation SET generation = generation + 1 WHERE id = 1; END;
    CREATE TEMP TRIGGER openclaw_session_reference_generation_node_update
      AFTER UPDATE ON main.session_nodes BEGIN UPDATE openclaw_session_reference_generation SET generation = generation + 1 WHERE id = 1; END;
    CREATE TEMP TRIGGER openclaw_session_reference_generation_window_insert
      AFTER INSERT ON main.session_windows BEGIN UPDATE openclaw_session_reference_generation SET generation = generation + 1 WHERE id = 1; END;
    CREATE TEMP TRIGGER openclaw_session_reference_generation_window_update
      AFTER UPDATE ON main.session_windows BEGIN UPDATE openclaw_session_reference_generation SET generation = generation + 1 WHERE id = 1; END;
  `);
  // A rolled-back schema change can reuse its version on retry after SQLite removes the triggers.
  if (!database.isTransaction) {
    referenceTrackerSchemaVersions.set(database, schemaRow.schema_version);
  }
}

function readSessionReferenceToken(database: DatabaseSync): SessionReferenceToken {
  ensureSessionReferenceTracker(database);
  const row =
    /* sqlite-allow-raw: the generation counter lives in the TEMP schema, outside the generated Kysely types. */ database
      .prepare("SELECT generation FROM temp.openclaw_session_reference_generation WHERE id = 1")
      // node:sqlite hands back an untyped row record for this TEMP-schema read.
      // SAFETY: the asserted shape types the column as `unknown`, so the assertion grants no value type; the `typeof` guard below is the only thing that admits it.
      .get() as { generation?: unknown };
  if (typeof row.generation !== "number") {
    throw new Error("SQLite session reference generation is unavailable");
  }
  return {
    dataVersion: readSqliteDataVersion(database),
    referenceGeneration: row.generation,
  };
}

/** Owner collector handed to a priming scan. */
type SessionReferenceOwnerSink = {
  add: (candidateSessionId: string, ownerSessionKey: string) => void;
};

/**
 * Performs the real scan and reports which key holds each candidate id.
 *
 * The connection is supplied rather than captured so a rebuild reads through
 * the handle that replaced the original, never the closed one it was primed on.
 */
export type SessionReferencePrime = (
  sink: SessionReferenceOwnerSink,
  database: DatabaseSync,
) => void;

function createOwnerSink(): {
  sink: SessionReferenceOwnerSink;
  owners: Map<string, Set<string>>;
} {
  const owners = new Map<string, Set<string>>();
  return {
    owners,
    sink: {
      add: (candidateSessionId, ownerSessionKey) => {
        const tracked = owners.get(candidateSessionId) ?? new Set<string>();
        if (tracked.size < MAX_TRACKED_OWNERS_PER_ID || tracked.has(ownerSessionKey)) {
          tracked.add(ownerSessionKey);
        }
        owners.set(candidateSessionId, tracked);
      },
    },
  };
}

/**
 * Runs the priming scan against `database` and installs the resulting batch,
 * or leaves no batch at all when the store cannot host the tracker.
 */
function primeSessionReferenceBatch(
  database: DatabaseSync,
  path: string,
  candidateSessionIds: ReadonlySet<string>,
  prime: SessionReferencePrime,
): SessionReferenceBatch | undefined {
  const { owners, sink } = createOwnerSink();
  try {
    // Read before the scan: a write landing during the scan then advances the
    // token past it, which costs a rebuild rather than trusting a torn pass.
    const token = readSessionReferenceToken(database);
    prime(sink, database);
    const batch: SessionReferenceBatch = {
      candidateSessionIds,
      database,
      ownersByCandidateSessionId: owners,
      prime,
      token,
    };
    activeBatches.set(path, batch);
    return batch;
  } catch {
    // A store that cannot host the tracker keeps the unbatched read path.
    activeBatches.delete(path);
    return undefined;
  }
}

/**
 * Examines the store once for `candidateSessionIds` and serves every reference
 * question about a subset of them from that one pass while `run` executes.
 *
 * `prime` performs the real scan and reports which key holds each id. The batch
 * is released when `run` settles, so nothing here is a long-lived cache: a later
 * sweep starts from a fresh pass.
 */
export async function withSessionReferenceBatch<T>(
  database: DatabaseSync,
  path: string,
  candidateSessionIds: readonly string[],
  prime: SessionReferencePrime,
  run: () => Promise<T>,
): Promise<T> {
  const previous = activeBatches.get(path);
  primeSessionReferenceBatch(database, path, new Set(candidateSessionIds), prime);
  try {
    return await run();
  } finally {
    if (previous) {
      activeBatches.set(path, previous);
    } else {
      activeBatches.delete(path);
    }
  }
}

/**
 * Returns the batch when a fresh reading from its own handle proves no insert
 * or update landed since the priming scan, and drops it when one did.
 */
function revalidateSessionReferenceBatch(
  batch: SessionReferenceBatch,
  database: DatabaseSync,
  path: string,
): SessionReferenceBatch | undefined {
  let token: SessionReferenceToken;
  try {
    token = readSessionReferenceToken(database);
  } catch {
    return undefined;
  }
  if (
    token.dataVersion !== batch.token.dataVersion ||
    token.referenceGeneration !== batch.token.referenceGeneration
  ) {
    // An insert or update since the priming scan could have created a reference,
    // so the caller re-reads instead of trusting the memo.
    activeBatches.delete(path);
    return undefined;
  }
  return batch;
}

/**
 * Ids among `candidateSessionIds` still referenced by a key outside
 * `excludedSessionKeys`, or `undefined` when the active batch cannot answer and
 * the caller must read the store.
 */
export function resolveBatchedReferencedSessionIds(
  database: DatabaseSync,
  path: string,
  excludedSessionKeys: ReadonlySet<string>,
  candidateSessionIds: readonly string[],
): Set<string> | undefined {
  const primed = activeBatches.get(path);
  if (
    !primed ||
    candidateSessionIds.length === 0 ||
    excludedSessionKeys.size >= MAX_TRACKED_OWNERS_PER_ID ||
    candidateSessionIds.some((sessionId) => !primed.candidateSessionIds.has(sessionId))
  ) {
    return undefined;
  }
  // A replaced handle cannot confirm the primed token, because both halves of
  // it restart on a new connection instead of advancing. Rebuild the whole
  // batch through the live handle so the remaining candidates keep their single
  // pass, and fall back to a store read if even that cannot be established.
  const batch =
    primed.database === database
      ? revalidateSessionReferenceBatch(primed, database, path)
      : primeSessionReferenceBatch(database, path, primed.candidateSessionIds, primed.prime);
  if (!batch) {
    return undefined;
  }
  return new Set(
    candidateSessionIds.filter((sessionId) =>
      [...(batch.ownersByCandidateSessionId.get(sessionId) ?? [])].some(
        (ownerSessionKey) => !excludedSessionKeys.has(ownerSessionKey),
      ),
    ),
  );
}
