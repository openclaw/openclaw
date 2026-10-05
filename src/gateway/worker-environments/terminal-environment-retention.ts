import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { sql, type Expression } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as StateDatabase } from "../../state/openclaw-state-db.generated.js";
import { WORKER_ENVIRONMENT_TERMINAL_STATES } from "./state.js";
import type {
  WorkerEnvironmentPruneObservation,
  WorkerEnvironmentPruneReadInput,
} from "./store.types.js";

const TERMINAL_ENVIRONMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const TERMINAL_ENVIRONMENT_PRUNE_LIMIT = 256;

type RetentionDatabase = Pick<
  StateDatabase,
  "worker_environments" | "worker_session_placements" | "worker_environment_recovery_holds"
>;

// Missing or malformed lifecycle facts retain custody, including legacy holds.
function settledDisposal(state: Expression<string>) {
  /* kysely-allow-raw: qualify JSON receipt fields inside the existing native retention query. */
  return sql<number>`(
    ${state} = 'destroyed'
    AND json_type(hold_json, '$.cleanup.requestedAtMs') = 'integer'
    AND json_type(hold_json, '$.cleanup.providerReleasedAtMs') = 'integer'
    AND json_type(hold_json, '$.cleanup.settledAtMs') = 'integer'
    AND json_extract(hold_json, '$.cleanup.requestedAtMs') >= 0
    AND json_extract(hold_json, '$.cleanup.providerReleasedAtMs') >= json_extract(hold_json, '$.cleanup.requestedAtMs')
    AND json_extract(hold_json, '$.cleanup.settledAtMs') >= json_extract(hold_json, '$.cleanup.providerReleasedAtMs')
    AND json_extract(hold_json, '$.cleanup.settledAtMs') <= ${Number.MAX_SAFE_INTEGER}
  )`;
}

function normalizeLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Worker environment prune limit must be between 1 and 1000");
  }
  return value;
}

export function readTerminalWorkerEnvironmentPrunePage(
  db: DatabaseSync,
  params: WorkerEnvironmentPruneReadInput,
) {
  if (!Number.isSafeInteger(params.nowMs) || params.nowMs < 0) {
    throw new Error("Worker environment prune timestamp must be a non-negative safe integer");
  }
  const limit = normalizeLimit(params.limit ?? TERMINAL_ENVIRONMENT_PRUNE_LIMIT);
  const cutoffMs = Math.max(0, params.nowMs - TERMINAL_ENVIRONMENT_RETENTION_MS);
  const query = getNodeSqliteKysely<RetentionDatabase>(db);
  let candidateQuery = query
    .selectFrom("worker_environments")
    .leftJoin(
      "worker_session_placements",
      "worker_session_placements.environment_id",
      "worker_environments.environment_id",
    )
    .selectAll("worker_environments")
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("worker_environment_recovery_holds")
            .select("environment_id")
            .whereRef("environment_id", "=", "worker_environments.environment_id")
            .where(settledDisposal(eb.ref("worker_environments.state")), "is not", 1),
        ),
      ),
    )
    .where("worker_environments.state", "in", WORKER_ENVIRONMENT_TERMINAL_STATES)
    .where("worker_environments.state_changed_at_ms", "<=", cutoffMs)
    .where("worker_session_placements.session_id", "is", null)
    .orderBy("worker_environments.state_changed_at_ms", "asc")
    .orderBy("worker_environments.environment_id", "asc")
    .limit(TERMINAL_ENVIRONMENT_PRUNE_LIMIT);
  if (params.cursor) {
    const pageCursor = params.cursor;
    candidateQuery = candidateQuery.where((eb) =>
      eb.or([
        eb("worker_environments.state_changed_at_ms", ">", pageCursor.changedAtMs),
        eb.and([
          eb("worker_environments.state_changed_at_ms", "=", pageCursor.changedAtMs),
          eb("worker_environments.environment_id", ">", pageCursor.environmentId),
        ]),
      ]),
    );
  }
  const candidates = executeSqliteQuerySync(db, candidateQuery).rows;
  const last = candidates.at(-1);
  return {
    limit,
    // Orphaned reserves retain capacity until physical cleanup succeeds.
    rows: candidates.filter((row) => row.state !== "orphaned" || row.preparation_key === null),
    nextCursor:
      last && candidates.length === TERMINAL_ENVIRONMENT_PRUNE_LIMIT
        ? { changedAtMs: last.state_changed_at_ms, environmentId: last.environment_id }
        : undefined,
  };
}

export function pruneObservedTerminalWorkerEnvironments(
  db: DatabaseSync,
  observations: readonly WorkerEnvironmentPruneObservation[],
): number {
  if (observations.length === 0) {
    return 0;
  }
  normalizeLimit(observations.length);
  const currentQuery = getNodeSqliteKysely<RetentionDatabase>(db);
  let deleted = 0;
  for (const observed of observations) {
    const current = executeSqliteQueryTakeFirstSync(
      db,
      currentQuery
        .selectFrom("worker_environments")
        .selectAll()
        .where("environment_id", "=", observed.environment_id)
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("worker_environment_recovery_holds")
                .select("environment_id")
                .whereRef("environment_id", "=", "worker_environments.environment_id")
                .where(settledDisposal(eb.ref("worker_environments.state")), "is not", 1),
            ),
          ),
        )
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("worker_session_placements")
                .select("session_id")
                .whereRef("environment_id", "=", "worker_environments.environment_id"),
            ),
          ),
        ),
    );
    // Policy may have re-entered the store. Revalidate every observed fact,
    // including the profile, activation and terminal age, under the write lock.
    // Worker transport drops the SQLite driver's null prototype; all column values stay exact.
    if (current && isDeepStrictEqual({ ...current }, { ...observed })) {
      executeSqliteQuerySync(
        db,
        currentQuery
          .deleteFrom("worker_environment_recovery_holds")
          .where("environment_id", "=", observed.environment_id)
          .where(settledDisposal(sql.val(current.state)), "is", 1),
      );
      const result = executeSqliteQuerySync(
        db,
        currentQuery
          .deleteFrom("worker_environments")
          .where("environment_id", "=", observed.environment_id),
      );
      deleted += Number(result.numAffectedRows ?? 0n);
    }
  }
  return deleted;
}
