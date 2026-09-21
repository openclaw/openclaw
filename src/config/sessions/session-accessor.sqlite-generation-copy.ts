import { createHash } from "node:crypto";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { publishSessionEntryCacheInvalidation } from "./session-accessor.sqlite-entry-cache.js";
import type {
  SqliteSessionGenerationClaim,
  SqliteSessionGenerationWindow,
} from "./session-accessor.sqlite-generation.types.js";
import { readSessionInputArtifactRows } from "./session-accessor.sqlite-pending-inputs-repair.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import {
  createTranscriptEventInserter,
  createTranscriptIdentityInserter,
} from "./session-accessor.sqlite-transcript-store.js";
import {
  assertSessionTranscriptHot,
  readSessionColdTranscript,
} from "./session-cold-storage-state.js";
import {
  markSessionTranscriptIndexDirtyInTransaction,
  reconcileSessionTranscriptIndexInTransaction,
} from "./session-transcript-index.js";
import { normalizeStoreSessionKey } from "./store-entry.js";

export function readSqliteSessionGenerationWindows(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionKeys: readonly string[],
  sessionIds: readonly string[],
): SqliteSessionGenerationWindow[] {
  return executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_windows")
      .selectAll()
      .where((eb) =>
        eb.or([
          eb("session_key", "in", sqliteStringSet(sessionKeys)),
          eb("session_id", "in", sqliteStringSet(sessionIds)),
        ]),
      )
      .orderBy("session_id"),
  ).rows;
}

function readSqliteSessionGenerationRows(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
) {
  const db = getSessionKysely(database.db);
  return {
    events: iterateSqliteQuerySync(
      database.db,
      db
        .selectFrom("transcript_events")
        .selectAll()
        .where("session_id", "=", sessionId)
        .orderBy("seq"),
    ),
    identities: iterateSqliteQuerySync(
      database.db,
      db
        .selectFrom("transcript_event_identities")
        .selectAll()
        .where("session_id", "=", sessionId)
        .orderBy("event_id"),
    ),
    rewriteWatermarks: iterateSqliteQuerySync(
      database.db,
      db
        .selectFrom("transcript_rewrite_watermarks")
        .selectAll()
        .where("session_id", "=", sessionId),
    ),
    trajectoryEvents: iterateSqliteQuerySync(
      database.db,
      db
        .selectFrom("trajectory_runtime_events")
        .selectAll()
        .where("session_id", "=", sessionId)
        .orderBy("seq"),
    ),
    parentStreamEvents: iterateSqliteQuerySync(
      database.db,
      db
        .selectFrom("acp_parent_stream_events")
        .selectAll()
        .where("session_id", "=", sessionId)
        .orderBy("run_id")
        .orderBy("seq"),
    ),
  };
}

export function readSqliteSessionGenerationClaim(
  database: Pick<OpenClawAgentDatabase, "db">,
  window: SqliteSessionGenerationWindow,
): SqliteSessionGenerationClaim {
  const rows = readSqliteSessionGenerationRows(database, window.session_id);
  const coldArchive = readSessionColdTranscript(database.db, window.session_id);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(window))
    .update("\n")
    .update(JSON.stringify(coldArchive ?? null))
    .update("\n");
  // Cleanup compares every stored fact; destination equality ignores ingestion and rewrite clocks.
  const contentFingerprint = createHash("sha256");
  if (coldArchive) {
    contentFingerprint.update(JSON.stringify(["cold", coldArchive])).update("\n");
  }
  const hashRows = <Row>(
    table: string,
    tableRows: Iterable<Row>,
    content?: (row: Row) => readonly unknown[],
  ) => {
    fingerprint.update(table).update("\n");
    for (const row of tableRows) {
      fingerprint.update(JSON.stringify(row)).update("\n");
      if (content) {
        contentFingerprint.update(JSON.stringify(content(row))).update("\n");
      }
    }
  };
  hashRows("events", rows.events, (row) => ["event", row.seq, row.event_json]);
  hashRows("identities", rows.identities, (row) => [
    "identity",
    row.event_id,
    row.event_type,
    row.parent_id,
    row.seq,
    row.message_idempotency_key,
  ]);
  hashRows("rewriteWatermarks", rows.rewriteWatermarks, () => ["rewrite"]);
  hashRows("trajectoryEvents", rows.trajectoryEvents, (row) => [
    "trajectory",
    row.seq,
    row.run_id,
    row.event_json,
  ]);
  hashRows("parentStreamEvents", rows.parentStreamEvents, (row) => [
    "parentStream",
    row.seq,
    row.run_id,
    row.event_json,
  ]);
  hashRows(
    "sessionConversations",
    executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("session_conversations")
        .selectAll()
        .where("session_id", "=", window.session_id)
        .orderBy("conversation_id")
        .orderBy("role"),
    ).rows,
    (row) => ["conversation", row.role, row.conversation_id, row.route_context_json],
  );
  const inputs = readSessionInputArtifactRows(database, window.session_id);
  hashRows("pendingInputs", inputs.pendingInputs);
  hashRows("inputCompletions", inputs.inputCompletions);
  return {
    window,
    coldArchive,
    fingerprint: fingerprint.digest("hex"),
    contentFingerprint: contentFingerprint.digest("hex"),
  };
}

export function rehomeSqliteSessionGenerationWindow(
  window: SqliteSessionGenerationWindow,
  canonicalKey: string,
  sourceKeys: ReadonlySet<string>,
): SqliteSessionGenerationWindow {
  return {
    ...window,
    session_key: canonicalKey,
    parent_session_key:
      window.parent_session_key &&
      sourceKeys.has(normalizeStoreSessionKey(window.parent_session_key.trim()))
        ? canonicalKey
        : window.parent_session_key,
    spawned_by:
      window.spawned_by && sourceKeys.has(normalizeStoreSessionKey(window.spawned_by.trim()))
        ? canonicalKey
        : window.spawned_by,
  };
}

export function copySqliteSessionGenerationRows(params: {
  destination: OpenClawAgentDatabase;
  sessionId: string;
  source: Pick<OpenClawAgentDatabase, "db">;
  sourceWindowPresent: boolean;
}): void {
  if (
    readOpenClawAgentDatabaseIdentity(params.source).identity ===
    readOpenClawAgentDatabaseIdentity(params.destination).identity
  ) {
    throw new Error(
      "Transcript generation copy requires distinct source and destination databases.",
    );
  }
  assertSessionTranscriptHot(params.source.db, params.sessionId);
  assertSessionTranscriptHot(params.destination.db, params.sessionId);
  const sourceDb = getSessionKysely(params.source.db);
  const tables = [
    "transcript_event_identities",
    "transcript_events",
    "transcript_rewrite_watermarks",
    "trajectory_runtime_events",
    "acp_parent_stream_events",
  ] as const;
  if (
    !params.sourceWindowPresent &&
    !tables.some((table) =>
      executeSqliteQueryTakeFirstSync(
        params.source.db,
        sourceDb
          .selectFrom(table)
          .select("session_id")
          .where("session_id", "=", params.sessionId)
          .limit(1),
      ),
    )
  ) {
    return;
  }
  const { events, identities, rewriteWatermarks, trajectoryEvents, parentStreamEvents } =
    readSqliteSessionGenerationRows(params.source, params.sessionId);
  const destinationDb = getSessionKysely(params.destination.db);
  for (const table of tables) {
    executeSqliteQuerySync(
      params.destination.db,
      destinationDb.deleteFrom(table).where("session_id", "=", params.sessionId),
    );
  }
  const insertEvent = createTranscriptEventInserter(params.destination, params.sessionId);
  for (const row of events) {
    insertEvent({ seq: row.seq, eventJson: row.event_json, createdAt: row.created_at });
  }
  // Preserve recorded idempotency ownership, which cannot be inferred from the JSON.
  const insertIdentity = createTranscriptIdentityInserter(
    params.destination,
    params.sessionId,
    false,
  );
  for (const row of identities) {
    insertIdentity({
      seq: row.seq,
      eventId: row.event_id,
      eventType: row.event_type,
      parentId: row.parent_id,
      messageIdempotencyKey: row.message_idempotency_key,
      createdAt: row.created_at,
    });
  }
  for (const row of rewriteWatermarks) {
    executeSqliteQuerySync(
      params.destination.db,
      destinationDb.insertInto("transcript_rewrite_watermarks").values(row),
    );
  }
  for (const row of trajectoryEvents) {
    executeSqliteQuerySync(
      params.destination.db,
      destinationDb.insertInto("trajectory_runtime_events").values(row),
    );
  }
  for (const row of parentStreamEvents) {
    executeSqliteQuerySync(
      params.destination.db,
      destinationDb.insertInto("acp_parent_stream_events").values(row),
    );
  }
  // Cross-store repair must atomically finish copied projections before publishing the new owner.
  markSessionTranscriptIndexDirtyInTransaction(params.destination.db, params.sessionId);
  reconcileSessionTranscriptIndexInTransaction(params.destination.db, params.sessionId);
  const owner = executeSqliteQueryTakeFirstSync(
    params.destination.db,
    destinationDb
      .selectFrom("session_windows")
      .select("session_key")
      .where("session_id", "=", params.sessionId),
  );
  if (owner) {
    publishSessionEntryCacheInvalidation(params.destination, { sessionKey: owner.session_key });
  }
}
