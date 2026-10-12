import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { SESSION_WATCH_PROVENANCE_AMBIENT_GROUP } from "../state/session-watch-cursor-provenance.js";
import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import {
  getSessionStateKysely,
  normalizeOptionalSqliteNumber,
  rowToSessionStateEvent,
} from "./session-state-events.kernel.js";

export function readSessionStateSequence(
  db: DatabaseSync,
  sessionKey: string,
  agentId: string,
): number {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getSessionStateKysely(db)
      .selectFrom("session_state_heads")
      .select("last_sequence")
      .where("session_key", "=", sessionKey)
      .where("agent_id", "=", agentId),
  );
  return normalizeOptionalSqliteNumber(row?.last_sequence) ?? 0;
}

export const sessionStateReadOperations = {
  "sessionState.pendingNotices": (_input: undefined, db) => ({
    type: "sessionState.pendingNotices" as const,
    cursors: executeSqliteQuerySync(
      db,
      getSessionStateKysely(db)
        .selectFrom("session_watch_cursors")
        // Older admitted stores omit watcher_store_path until the first feature write.
        .selectAll()
        .whereRef("material_sequence", ">", "last_seen_sequence"),
    ).rows.map((row) => ({
      watcherSessionKey: row.watcher_session_key,
      targetSessionKey: row.target_session_key,
      watcherStorePath: row.watcher_store_path ?? null,
    })),
  }),
  "sessionState.ambientTargets": (input: { watcherSessionKey: string }, db) => ({
    type: "sessionState.ambientTargets" as const,
    targets: executeSqliteQuerySync(
      db,
      getSessionStateKysely(db)
        .selectFrom("session_watch_cursors")
        .select("target_session_key")
        .where("watcher_session_key", "=", input.watcherSessionKey)
        .where("provenance", "=", SESSION_WATCH_PROVENANCE_AMBIENT_GROUP),
    ).rows.map((row) => row.target_session_key),
  }),
  "sessionState.versions": (refs: ReadonlyArray<{ sessionKey: string; agentId: string }>, db) => {
    const keys = [...new Set(refs.map((ref) => ref.sessionKey).filter(Boolean))];
    const versions = new Map<string, Map<string, number>>();
    // sessions_list accepts arbitrary limits; keep each statement below SQLite's bind limit.
    for (let offset = 0; offset < keys.length; offset += 500) {
      const rows = executeSqliteQuerySync(
        db,
        getSessionStateKysely(db)
          .selectFrom("session_state_heads")
          .select(["session_key", "agent_id", "last_sequence"])
          .where("session_key", "in", keys.slice(offset, offset + 500)),
      ).rows;
      for (const row of rows) {
        let sessions = versions.get(row.agent_id);
        if (!sessions) {
          sessions = new Map();
          versions.set(row.agent_id, sessions);
        }
        sessions.set(row.session_key, normalizeSqliteNumber(row.last_sequence) ?? 0);
      }
    }
    return {
      type: "sessionState.versions" as const,
      versions: Object.fromEntries(
        [...versions].map(([agentId, sessions]) => [agentId, Object.fromEntries(sessions)]),
      ),
    };
  },
  "sessionState.events": (
    input: { sessionKey: string; agentId: string; afterSequence: number; limit: number },
    db,
  ) =>
    runSqliteDeferredTransactionSync(db, () => {
      const { sessionKey, agentId, afterSequence } = input;
      const boundedLimit = Math.max(1, Math.min(200, Math.floor(input.limit)));
      const kysely = getSessionStateKysely(db);
      const rows = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("session_state_events")
          .selectAll()
          .where("session_key", "=", sessionKey)
          .where("agent_id", "=", agentId)
          .where("sequence", ">", afterSequence)
          .orderBy("sequence", "asc")
          .limit(boundedLimit + 1),
      ).rows;
      const earliest = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("session_state_events")
          .select((eb) => eb.fn.min<number>("sequence").as("sequence"))
          .where("session_key", "=", sessionKey)
          .where("agent_id", "=", agentId),
      );
      const headRow = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("session_state_heads")
          .select(["last_sequence", "pruned_max_sequence"])
          .where("session_key", "=", sessionKey)
          .where("agent_id", "=", agentId),
      );
      const head = normalizeOptionalSqliteNumber(headRow?.last_sequence) ?? 0;
      const prunedMax = normalizeOptionalSqliteNumber(headRow?.pruned_max_sequence) ?? 0;
      return {
        type: "sessionState.events" as const,
        page: {
          events: rows.slice(0, boundedLimit).map(rowToSessionStateEvent),
          truncated: rows.length > boundedLimit,
          earliestAvailableSequence:
            normalizeOptionalSqliteNumber(earliest?.sequence) ?? (head > 0 ? head + 1 : 0),
          // Global sequence gaps do not prove pruning; only this session's watermark does.
          historyGap: afterSequence < prunedMax,
        },
      };
    }),
} satisfies WorkerOperationHandlers<DatabaseSync>;
