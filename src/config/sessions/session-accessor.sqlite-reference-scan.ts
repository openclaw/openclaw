import { toUSVString } from "node:util";
import { sql } from "kysely";
import { iterateSqliteQuerySync, sqliteStringSet } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withSessionReferenceBatch } from "./session-accessor.sqlite-reference-batch.js";
import {
  addRetainedWindowSessionReferences,
  collectSessionStateIdsForEntry,
  SESSION_STATE_ID_TRIM_CHARACTERS,
} from "./session-accessor.sqlite-references.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson as parseSessionEntryRow } from "./session-accessor.sqlite-status.js";

/**
 * Narrowed reference reads and the batched analysis built on them.
 *
 * Split out of `session-accessor.sqlite-lifecycle-state.ts`, which owns entry
 * lifecycle projection and deletion planning. These are the reads those owners
 * consult rather than part of the planning itself, and they form one coherent
 * unit: the narrowing predicate exists to make the priming scan affordable, and
 * the priming scan is the only caller that narrows.
 */

/**
 * Ids pushed into one narrowed reference read.
 *
 * The narrowing is a prefilter, never the decision: exact membership is still
 * settled in JS below. Beyond this many ids the predicate stops paying for
 * itself and the read falls back to full hydration, which is what every
 * multi-id caller used to get unconditionally.
 */
const REFERENCE_NARROWING_ID_LIMIT = 64;

/** Ids whose text survives Node/SQLite conversion unchanged can be compared in SQLite. */
function isNarrowableSessionId(sessionId: string): boolean {
  return toUSVString(sessionId) === sessionId && !/[\0\uFFFD-\uFFFF]/u.test(sessionId);
}

/**
 * Rows that could reference one of `candidateSessionIds`.
 *
 * Exact `IN` membership replaces the former `instr` probe and generalizes to a
 * set, but equality alone is narrower than the reference parser, so each way a
 * row can still own a candidate keeps its own branch:
 *
 * - `collectSessionStateIdsForEntry` trims every id it collects, and an entry
 *   parses only when its `sessionId` equals `current_session_id`, so a padded
 *   current id protects its trimmed form. The `trim` branch reproduces exactly
 *   the code points `String.prototype.trim` removes. `instr` used to cover this
 *   case incidentally, by matching the candidate embedded in the padded id.
 * - A `current_session_id` holding raw bytes SQLite cannot convert is retained
 *   by the length branch, which `instr` could silently drop.
 * - Optional reference fields are retained by presence, never by value.
 *
 * The narrowing stays a prefilter, never the decision: exact membership is still
 * settled in JS below, so retaining a row that owns nothing costs only hydration.
 */
function referenceCandidateNarrowing(candidateSessionIds: readonly string[]) {
  const ids = sql.join(candidateSessionIds.map((sessionId) => sql`${sessionId}`));
  const trimmedIds = sql.join(candidateSessionIds.map((sessionId) => sql`${sessionId}`));
  return /* kysely-allow-raw: narrow hydration without replacing the reference parser or its raw-text fallbacks. */ sql<boolean>`(
        current_session_id IN (${ids})
        OR trim(current_session_id, ${SESSION_STATE_ID_TRIM_CHARACTERS}) IN (${trimmedIds})
        OR length(CAST(current_session_id AS BLOB)) != length(CAST(printf('%s', current_session_id) AS BLOB))
        OR NOT json_valid(entry_json)
        OR length(CAST(entry_json AS BLOB)) != length(CAST(printf('%s', entry_json) AS BLOB))
        OR json_type(entry_json, '$.previousSessionId') IS NOT NULL
        OR json_type(entry_json, '$.usageFamilySessionIds') IS NOT NULL
        OR json_type(entry_json, '$.compactionCheckpoints') IS NOT NULL
      )`;
}

function selectReferenceRows(
  database: Pick<OpenClawAgentDatabase, "db">,
  excludedSessionKeys: ReadonlySet<string>,
  candidateSessionIds?: readonly string[],
) {
  const db = getSessionKysely(database.db);
  // Only push down keys unchanged by Node/SQLite text conversion; retain exact membership below.
  const excludedKeys = [...excludedSessionKeys].filter(
    (key) => toUSVString(key) === key && !key.includes("\0") && !/[\uFFFE\uFFFF]/u.test(key),
  );
  const narrowable =
    candidateSessionIds !== undefined &&
    candidateSessionIds.length > 0 &&
    candidateSessionIds.length <= REFERENCE_NARROWING_ID_LIMIT &&
    candidateSessionIds.every((sessionId) => isNarrowableSessionId(sessionId));
  return db
    .selectFrom("session_nodes")
    .select(["entry_json", "current_session_id", "session_key"])
    .$if(excludedKeys.length > 0, (builder) =>
      builder.where("session_key", "not in", sqliteStringSet(excludedKeys)),
    )
    .$if(narrowable, (builder) =>
      builder.where(referenceCandidateNarrowing(candidateSessionIds ?? [])),
    );
}

/**
 * Examines the store once for `candidateSessionIds`, recording which key holds
 * each of them, and answers every later reference question about a subset of
 * those ids from that single pass while `run` executes.
 *
 * Callers that reclaim many candidates in sequence otherwise re-examine the
 * whole node table at each candidate's boundaries, because the reference
 * predicate has to reach every row that could hold an arbitrary reference and
 * no index can serve it. Freshness is preserved rather than dropped: the memo
 * is only used while a connection-local token proves no insert or update landed
 * since the pass, and any later boundary re-reads the store the moment it does.
 * That token is only believed against the handle that produced it, so a cached
 * connection replaced mid-batch rebuilds the pass rather than inheriting a
 * proof whose two halves restart on a new connection.
 */
export async function withBatchedSessionReferenceAnalysis<T>(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  candidateSessionIds: readonly string[],
  run: () => Promise<T>,
): Promise<T> {
  return await withSessionReferenceBatch(
    database.db,
    database.path,
    candidateSessionIds,
    // Reads through the handle the batch is being primed on, which is not
    // necessarily the one captured above: a rebuild after the cached connection
    // is replaced mid-batch must scan the replacement, never the closed handle.
    (sink, connection) => {
      const scoped = { db: connection };
      const candidates = new Set(candidateSessionIds);
      for (const row of iterateSqliteQuerySync(
        connection,
        selectReferenceRows(scoped, new Set(), candidateSessionIds),
      )) {
        if (candidates.has(row.current_session_id)) {
          sink.add(row.current_session_id, row.session_key);
        }
        const entry = parseSessionEntryRow(row);
        for (const sessionId of entry ? collectSessionStateIdsForEntry(entry) : []) {
          if (candidates.has(sessionId)) {
            sink.add(sessionId, row.session_key);
          }
        }
      }
      addRetainedWindowSessionReferences(
        scoped,
        new Set<string>(),
        new Set(),
        candidateSessionIds,
        undefined,
        sink.add,
      );
    },
    run,
  );
}
