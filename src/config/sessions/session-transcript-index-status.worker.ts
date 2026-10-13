import type { DatabaseSync } from "node:sqlite";
import type { RawBuilder } from "kysely";
import { registerNodeSqliteDisposeCallback } from "../../infra/kysely-sync-cache-state.js";
import {
  createSqliteQueryCache,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  prepareSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
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
import { sessionTranscriptIndexNeedsReconcile } from "./session-transcript-index.js";

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
  const selectNext = (after?: RawBuilder<string>) => {
    const [first, ...remaining] = scanTables.map((table) => {
      const source =
        table === "openclaw_transcript_index_pending" ? kysely.withSchema("temp") : kysely;
      let query = source.selectFrom(table).select("session_id").orderBy("session_id").limit(1);
      if (after) {
        query = query.where("session_id", ">", after);
      }
      return kysely.selectFrom(query.as("candidate")).select("session_id");
    });
    return kysely
      .selectFrom(remaining.reduce((query, next) => query.unionAll(next), first!).as("candidates"))
      .select("session_id")
      .orderBy("session_id")
      .limit(1);
  };
  return {
    first: prepareSqliteQueryTakeFirstSync<void, { session_id: string }>(db, () => selectNext()),
    after: prepareSqliteQueryTakeFirstSync<string, { session_id: string }>(db, (parameter) =>
      selectNext(parameter((sessionId) => sessionId)),
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
    kind: "transcript-index",
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

/** Consume the writer's clean receipt without taking a write lock or host write grants. */
export function isSessionTranscriptIndexStatusClean(db: DatabaseSync): boolean {
  const siblingWriteRevision = readSqliteDatabaseSiblingWriteRevision(db);
  const schema = getAdmittedSqliteSchemaFacts(db);
  if (
    siblingWriteRevision === undefined ||
    !schema ||
    installations.get(db)?.schemaVersion !== schema.schemaVersion
  ) {
    return false;
  }
  const temporary = getNodeSqliteKysely<StatusDatabase>(db).withSchema("temp");
  return (
    executeSqliteQueryTakeFirstSync(
      db,
      temporary
        .selectFrom("openclaw_transcript_index_status")
        .select("id")
        .where("id", "=", 1)
        .where("sibling_write_revision", "=", siblingWriteRevision)
        .where("schema_version", "=", schema.schemaVersion)
        .where("complete", "=", 1)
        .where((eb) =>
          eb.not(
            eb.exists(
              temporary.selectFrom("openclaw_transcript_index_pending").select("session_id"),
            ),
          ),
        ),
    ) !== undefined && readSqliteDatabaseSiblingWriteRevision(db) === siblingWriteRevision
  );
}

/** Advance bounded maintenance inside the canonical writer's transaction. */
export function maintainSessionTranscriptIndexStatus(db: DatabaseSync): {
  sessionIds: string[];
  hasMore: boolean;
  traversalComplete: boolean;
  /** Clean fast receipts need no traversal history. */
  traversal?: { schemaVersion: number; completedTraversals: number };
} {
  if (!db.isTransaction) {
    throw new Error("Transcript projection status requires its writer transaction");
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
  const seek = admissionSeeks(db);
  let seeks = 0;
  let reachedTraversalEnd = false;
  while (candidates.size < MAX_SESSIONS && !state.complete && seeks++ < MAX_SESSIONS) {
    const next = state.after_session === null ? seek.first() : seek.after(state.after_session);
    if (!next) {
      state.complete = 1;
      reachedTraversalEnd = true;
      state.completed_traversals++;
    } else {
      state.after_session = next.session_id;
      candidates.add(next.session_id);
    }
  }
  const remainingRows = projectionTables.map(() => MAX_ORPHAN_ROWS);
  for (const sessionId of candidates) {
    const hasTranscript =
      executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("transcript_events")
          .select("seq")
          .where("session_id", "=", sessionId)
          .limit(1),
      ) !== undefined;
    let pending = false;
    let unfinished = false;
    if (hasTranscript) {
      pending = sessionTranscriptIndexNeedsReconcile(db, sessionId);
    } else {
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
                  selected.map((row) => row.rowId),
                ),
              ),
            ).numAffectedRows ?? 0n;
          remainingRows[index]! -= Number(removed);
        }
      }
    }
    // Cleanup triggers can requeue this session; consume only after its final observation.
    executeSqliteQuerySync(
      db,
      temporary.deleteFrom("openclaw_transcript_index_pending").where("session_id", "=", sessionId),
    );
    if (pending || unfinished) {
      executeSqliteQuerySync(
        db,
        temporary
          .insertInto("openclaw_transcript_index_pending")
          .values({ session_id: sessionId, state: unfinished ? 0 : 1 }),
      );
    }
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
