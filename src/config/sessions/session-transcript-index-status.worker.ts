import type { DatabaseSync } from "node:sqlite";
import type { RawBuilder } from "kysely";
import { registerNodeSqliteDisposeCallback } from "../../infra/kysely-sync-cache-state.js";
import {
  createSqliteQueryCache,
  encodeSqliteStringSet,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
  sqliteStringSetEntries,
} from "../../infra/kysely-sync.js";
import { isPostgresSqlConnection, type EngineConnection } from "../../infra/sql-connection.js";
import {
  readSqliteDatabaseSiblingWriteRevision,
  sqliteSessionIdWriteScope,
  withSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import {
  getAdmittedSqliteSchemaFacts,
  installSqliteTempTrackingSchema,
} from "../../infra/sqlite-schema-facts.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  deleteOrphanedTranscriptIndexRowsInTransaction,
  listSessionsNeedingTranscriptIndexReconcile,
  selectSessionTranscriptIndexStatus,
} from "./session-transcript-index.js";

const projectionTables = [
  "session_transcript_active_events",
  "session_transcript_fts_rows",
  "session_transcript_index_state",
] as const;
const observedTables = ["session_windows", ...projectionTables, "transcript_events"] as const;
const scanTables = [
  "session_windows",
  ...projectionTables,
  "openclaw_transcript_index_pending",
] as const;
const MAX_SESSIONS = 128;
const MAX_ORPHAN_ROWS = 512;
const installations = new WeakMap<DatabaseSync, { schemaVersion?: number }>();

type StatusDatabase = Pick<DB, "session_windows" | "transcript_events"> & {
  [Table in (typeof projectionTables)[number]]: DB[Table] & { rowid: number };
} & {
  openclaw_transcript_index_status: {
    id: number;
    sibling_write_revision: number;
    schema_version: number;
    complete: number;
    after_session: string | null;
    completed_traversals: number;
  };
  openclaw_transcript_index_pending: { session_id: string; state: number };
};

const admissionSeeks = createSqliteQueryCache((db) => {
  const kysely = getNodeSqliteKysely<StatusDatabase>(db);
  const selectBatch = (after?: RawBuilder<string>) => {
    const [first, ...remaining] = scanTables.map((table) => {
      const source =
        table === "openclaw_transcript_index_pending" ? kysely.withSchema("temp") : kysely;
      // Seek past each session's entire index range, including large transcripts.
      const keys = source.withRecursive("session_keys", (query) => {
        let firstKey = query
          .selectFrom(table)
          .select((eb) => [
            eb.fn.min<string | null>("session_id").as("session_id"),
            eb.val(1).as("depth"),
          ]);
        if (after) {
          firstKey = firstKey.where("session_id", ">", after);
        }
        return firstKey.unionAll(
          query
            .selectFrom("session_keys")
            .select((eb) => [
              eb
                .selectFrom(table)
                .select((inner) => inner.fn.min<string | null>("session_id").as("session_id"))
                .whereRef(`${table}.session_id`, ">", "session_keys.session_id")
                .as("session_id"),
              eb("depth", "+", 1).as("depth"),
            ])
            .where("session_id", "is not", null)
            .where("depth", "<", MAX_SESSIONS),
        );
      });
      return kysely
        .selectFrom(keys.selectFrom("session_keys").select("session_id").as("candidate"))
        .select("session_id")
        .where("session_id", "is not", null);
    });
    return kysely
      .selectFrom(remaining.reduce((query, next) => query.union(next), first!).as("candidates"))
      .select("session_id")
      .orderBy("session_id")
      .limit(MAX_SESSIONS);
  };
  return {
    first: prepareSqliteQuerySync<void, { session_id: string }>(db, () => selectBatch()),
    after: prepareSqliteQuerySync<string, { session_id: string }>(db, (parameter) =>
      selectBatch(parameter((sessionId) => sessionId)),
    ),
  };
});

function installStatusTracking(db: DatabaseSync, schemaVersion: number): void {
  let installation = installations.get(db);
  if (!installation) {
    installation = {};
    installations.set(db, installation);
    const retained = installation;
    registerNodeSqliteDisposeCallback(db, () => {
      retained.schemaVersion = undefined;
    });
  }
  if (installation.schemaVersion === schemaVersion) {
    return;
  }
  installSqliteTempTrackingSchema(db, {
    statusTable: "openclaw_transcript_index_status",
    pendingTable: "openclaw_transcript_index_pending",
    pendingIndex: "openclaw_transcript_index_pending_state",
    observedTables,
  });
  // Only installation is cached in JS; unmanaged transactions install again on the next call.
  stageSqliteTransactionState(db, {
    stage: () => {
      installation.schemaVersion = schemaVersion;
    },
    rollback: () => {
      installation.schemaVersion = undefined;
    },
    commit: () => {},
  });
}

/** Advance bounded maintenance inside the canonical writer's transaction. */
export function maintainSessionTranscriptIndexStatus(db: EngineConnection): {
  sessionIds: string[];
  hasMore: boolean;
  traversalComplete: boolean;
  /** Clean fast receipts need no traversal history. */
  traversal?: { schemaVersion: number; completedTraversals: number };
} {
  if (!db.isTransaction) {
    throw new Error("Transcript projection status requires its writer transaction");
  }
  if (isPostgresSqlConnection(db)) {
    deleteOrphanedTranscriptIndexRowsInTransaction(db);
    const sessionIds = listSessionsNeedingTranscriptIndexReconcile(db, MAX_SESSIONS + 1);
    return {
      sessionIds: sessionIds.slice(0, MAX_SESSIONS),
      hasMore: sessionIds.length > MAX_SESSIONS,
      traversalComplete: true,
    };
  }
  const siblingWriteRevision = readSqliteDatabaseSiblingWriteRevision(db);
  const schema = getAdmittedSqliteSchemaFacts(db);
  if (!schema) {
    throw new Error("Transcript projection status requires admitted schema facts");
  }
  installStatusTracking(db, schema.schemaVersion);
  const kysely = getNodeSqliteKysely<StatusDatabase>(db);
  const temporary = kysely.withSchema("temp");
  const state = executeSqliteQueryTakeFirstSync(
    db,
    temporary.selectFrom("openclaw_transcript_index_status").selectAll().where("id", "=", 1),
  )!;
  // An unknown sibling revision only blocks the clean receipt; resetting here would rescan
  // the first batch forever and never reach later dirty sessions.
  if (state.schema_version !== schema.schemaVersion) {
    executeSqliteQuerySync(db, temporary.deleteFrom("openclaw_transcript_index_pending"));
    state.complete = 0;
    state.after_session = null;
    state.sibling_write_revision = siblingWriteRevision ?? -1;
  } else if (state.complete && state.sibling_write_revision !== siblingWriteRevision) {
    state.complete = 0;
    state.after_session = null;
    state.sibling_write_revision = siblingWriteRevision ?? -1;
  }
  const candidates = new Set(
    executeSqliteQuerySync(
      db,
      temporary
        .selectFrom("openclaw_transcript_index_pending")
        .select("session_id")
        .where("state", "=", 0)
        .orderBy("session_id")
        .limit(state.complete ? MAX_SESSIONS : MAX_SESSIONS / 2),
    ).rows.map((row) => row.session_id),
  );
  // Reserve traversal work despite local churn; TEMP candidates retain deleted sessions.
  let reachedTraversalEnd = false;
  if (!state.complete) {
    const seeks = admissionSeeks(db);
    const batch = (state.after_session === null ? seeks.first() : seeks.after(state.after_session))
      .rows;
    let consumed = 0;
    for (const row of batch) {
      if (candidates.size === MAX_SESSIONS) {
        break;
      }
      state.after_session = row.session_id;
      candidates.add(row.session_id);
      consumed++;
    }
    if (consumed === batch.length && batch.length < MAX_SESSIONS) {
      state.complete = 1;
      reachedTraversalEnd = true;
      state.completed_traversals++;
    }
  }
  const classified =
    candidates.size === 0
      ? []
      : executeSqliteQuerySync(
          db,
          kysely
            .selectFrom(
              sqliteStringSetEntries(encodeSqliteStringSet([...candidates])).as("candidate"),
            )
            .select("candidate.value as session_id")
            .select((eb) =>
              kysely
                .selectFrom(
                  selectSessionTranscriptIndexStatus(db, eb.ref("candidate.value").$notNull()).as(
                    "status",
                  ),
                )
                .select("needs_reconcile")
                .as("needs_reconcile"),
            ),
        ).rows;
  const pending: { session_id: string; state: number }[] = [];
  const remainingRows = projectionTables.map(() => MAX_ORPHAN_ROWS);
  for (const row of classified) {
    const sessionId = row.session_id!;
    let unfinished = false;
    if (row.needs_reconcile === null) {
      for (const [index, table] of projectionTables.entries()) {
        const budget = remainingRows[index]!;
        const rows = executeSqliteQuerySync(
          db,
          kysely
            .selectFrom(table)
            .select("rowid as rowId")
            .where("session_id", "=", sessionId)
            .limit(budget + 1),
        ).rows;
        unfinished ||= rows.length > budget;
        const selected = rows.slice(0, budget);
        // Empty cleanup must not publish a write receipt that invalidates clean search hits.
        if (selected.length > 0) {
          const removed =
            withSqliteDatabaseWriteScope(db, [sqliteSessionIdWriteScope(sessionId)], () =>
              executeSqliteQuerySync(
                db,
                kysely.deleteFrom(table).where(
                  "rowid",
                  "in",
                  selected.map((orphanRow) => orphanRow.rowId),
                ),
              ),
            ).numAffectedRows ?? 0n;
          remainingRows[index]! -= Number(removed);
        }
      }
    }
    if (row.needs_reconcile || unfinished) {
      pending.push({ session_id: sessionId, state: unfinished ? 0 : 1 });
    }
  }
  // Cleanup triggers can requeue candidates; consume after all bounded deletions.
  if (candidates.size > 0) {
    executeSqliteQuerySync(
      db,
      temporary
        .deleteFrom("openclaw_transcript_index_pending")
        .where("session_id", "in", [...candidates]),
    );
  }
  if (pending.length > 0) {
    executeSqliteQuerySync(
      db,
      temporary.insertInto("openclaw_transcript_index_pending").values(pending),
    );
  }
  const hasUnknown =
    state.complete !== 0 &&
    executeSqliteQueryTakeFirstSync(
      db,
      temporary
        .selectFrom("openclaw_transcript_index_pending")
        .select("session_id")
        .where("state", "=", 0)
        .limit(1),
    ) !== undefined;
  // Rebuild known work after enumeration without waiting for sibling writers to become quiet.
  const traversalComplete = reachedTraversalEnd || (state.complete !== 0 && !hasUnknown);
  // Resume fair traversal when local churn outgrows queue classification. Sibling commits
  // restart only after reaching the end, so neither source of writes can starve late keys.
  if (
    state.complete &&
    (state.sibling_write_revision !== siblingWriteRevision || (hasUnknown && !reachedTraversalEnd))
  ) {
    state.complete = 0;
    state.after_session = null;
    state.sibling_write_revision = siblingWriteRevision ?? -1;
  }
  executeSqliteQuerySync(
    db,
    temporary
      .updateTable("openclaw_transcript_index_status")
      .set({
        sibling_write_revision: state.sibling_write_revision,
        schema_version: schema.schemaVersion,
        complete: state.complete,
        after_session: state.after_session,
        completed_traversals: state.completed_traversals,
      })
      .where("id", "=", 1),
  );
  const sessionIds = executeSqliteQuerySync(
    db,
    temporary
      .selectFrom("openclaw_transcript_index_pending")
      .select("session_id")
      .where("state", "=", 1)
      .orderBy("session_id"),
  ).rows.map((row) => row.session_id);
  return {
    sessionIds,
    hasMore: siblingWriteRevision === undefined || !state.complete || hasUnknown,
    traversalComplete: siblingWriteRevision !== undefined && traversalComplete,
    traversal: {
      schemaVersion: schema.schemaVersion,
      completedTraversals: state.completed_traversals,
    },
  };
}
