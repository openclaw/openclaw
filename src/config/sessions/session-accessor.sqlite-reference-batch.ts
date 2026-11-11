import type { DatabaseSync } from "node:sqlite";
import {
  cacheValidityTokensEqual,
  readSessionEntryCacheValidityToken,
  type SqliteSessionEntryRevision,
} from "./session-accessor.sqlite-entry-revision.js";

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
 * The proof is the store's shared connection validity token
 * (`readSessionEntryCacheValidityToken`), the same one the session entry cache
 * keys its own reuse on:
 *
 * - the shared sibling write revision advances whenever another connection
 *   commits, which is the only way an external writer can appear;
 * - the writer's native mutation revision observes writes on *this*
 *   connection, which the sibling revision deliberately does not report;
 * - the admitted schema version covers schema replacement.
 *
 * The halves are connection-local in the strict sense: a reading is only
 * comparable against another reading from the *same* handle. A replacement
 * connection restarts its revision baselines, so two readings taken across a
 * close and reopen can be equal even though another connection committed a
 * reference in between — the numbers reset rather than advance, which is
 * indistinguishable from nothing having happened. A batch therefore records the
 * handle that produced its token and is rebuilt on a replacement instead of
 * being trusted across one. `cacheValidityTokensEqual` additionally refuses any
 * token whose shared half the admission owner could not report, so an
 * unprovable reading never matches.
 *
 * The native mutation revision observes every write on this connection,
 * including deletes. A `DELETE` can remove a reference but never create one, so
 * treating it as invalidating is conservative in the safe direction: a rebuilt
 * pass can only find fewer holders. It does mean a sweep that reclaims its own
 * candidates re-primes at those boundaries rather than carrying one pass across
 * them, which costs amortization and never correctness.
 */
type SessionReferenceToken = SqliteSessionEntryRevision;

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

/**
 * Reads the validity token for `database`.
 *
 * This is the store-wide connection token the session entry cache already
 * keys its own reuse on: the shared sibling write revision for other
 * connections' commits, plus the writer's native mutation revision for this
 * connection's own writes, plus the admitted schema version. It throws when
 * either the admitted facts or a tracked writer is missing; both callers treat
 * a failed token read as "cannot prove" and fall back to reading the store.
 */
function readSessionReferenceToken(database: DatabaseSync): SessionReferenceToken {
  return readSessionEntryCacheValidityToken(database);
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
 * Returns the batch when a fresh reading from its own handle proves no write
 * landed since the priming scan, and drops it when one did.
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
  if (!cacheValidityTokensEqual(batch.token, token)) {
    // A write since the priming scan could have created a reference, so the
    // caller re-reads instead of trusting the memo.
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
