import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql, type ColumnType, type Generated, type InferResult } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  prepareSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  extractTranscriptIndexEntry,
  hasTranscriptMessage,
  prepareSessionTranscriptProjectionAppend,
  shouldProjectActiveEvent,
  transcriptEventContextEligibility,
  type SessionTranscriptProjectionCursor,
  type TranscriptIndexEntry,
} from "./session-transcript-projection-append.js";
import {
  isCanonicalSessionTranscriptEntry,
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";

type TranscriptProjectionDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "session_windows"
  | "session_transcript_index_state"
  | "transcript_events"
  | "transcript_rewrite_watermarks"
> & {
  session_transcript_active_events: OpenClawAgentKyselyDatabase["session_transcript_active_events"] & {
    rowid: Generated<number>;
  };
  session_transcript_fts: Omit<
    OpenClawAgentKyselyDatabase["session_transcript_fts"],
    "timestamp"
  > & {
    rowid: Generated<number>;
    timestamp: ColumnType<string | null, number | string | null, number | string | null>;
  };
};

export type PreparedSessionTranscriptProjectionMetadata = {
  activeEventCount: number;
  activeMessageCount: number;
  leafEventId: string | null;
  sessionId: string;
  sourceHasInvalidLeafControl: boolean;
  sourceIndexedSeq: number;
  sourceTranscriptGeneration: string | null;
  sourceTranscriptUpdatedAt: number | null;
};

export type PreparedSessionTranscriptProjection = PreparedSessionTranscriptProjectionMetadata & {
  activeRows: Array<{
    activePosition: number;
    contextEligible: 0 | 1;
    eventSeq: number;
    messagePosition: number | null;
  }>;
  ftsRows: TranscriptIndexEntry[];
};

type ProjectionDeleteChunkResult = {
  hasMore: boolean;
  owned: boolean;
};

export type SessionTranscriptProjectionRow = {
  event_json: string;
  seq: number;
  created_at: number;
};

type SessionTranscriptProjectionSource = {
  sessionId: string;
  transcriptGeneration: string | null;
  transcriptUpdatedAt: number | null;
  rows: () => Iterable<SessionTranscriptProjectionRow>;
  row: (seq: number) => SessionTranscriptProjectionRow | undefined;
};

type TranscriptProjectionSourceSnapshot = {
  generation: string | null;
  latestSeq: number | undefined;
  transcriptUpdatedAt: number | null;
};

const PROJECTION_FINALIZE_TAIL_ROWS = 512;
const PROJECTION_FINALIZE_TAIL_BYTES = 256 * 1024;

function transcriptEventStoredByteLength() {
  return /* kysely-allow-raw: byte bounds measure stored UTF-8 event_json bytes. */ sql<number>`length(CAST(event_json AS BLOB))`.as(
    "event_bytes",
  );
}

function getProjectionKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<TranscriptProjectionDatabase>(db);
}

/** Older same-version writers can leave a current watermark over unclassified rows. */
export function hasUnclassifiedSessionTranscriptEvents(
  db: DatabaseSync,
  sessionId: string,
): boolean {
  return (
    executeSqliteQueryTakeFirstSync(
      db,
      getProjectionKysely(db)
        .selectFrom("session_transcript_active_events")
        .select("session_id")
        .where("session_id", "=", sessionId)
        .where("context_eligible", "is", null)
        .limit(1),
    ) !== undefined
  );
}

function readCanonicalEventId(event: unknown): string | null {
  if (!isCanonicalSessionTranscriptEntry(event) || typeof event.id !== "string") {
    return null;
  }
  return event.id.trim() || null;
}

function changesPriorProjectionVisibility(event: unknown): boolean {
  return isCanonicalSessionTranscriptEntry(event) && event.type === "reset";
}

/** Streams projection payloads; only navigation metadata is retained for branch resolution. */
export function visitSessionTranscriptProjection(
  db: DatabaseSync,
  sessionId: string,
  visitor: {
    activeRow: (row: PreparedSessionTranscriptProjection["activeRows"][number]) => void;
    ftsRow: (row: TranscriptIndexEntry) => void;
  },
): PreparedSessionTranscriptProjectionMetadata | undefined {
  const source = readProjectionSource(db, sessionId);
  return source ? visitProjectionSource(source, visitor) : undefined;
}

function readProjectionSource(
  db: DatabaseSync,
  sessionId: string,
): SessionTranscriptProjectionSource | undefined {
  const kysely = getProjectionKysely(db);
  const session = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("session_windows as session")
      .leftJoin(
        "transcript_rewrite_watermarks as rewrite",
        "rewrite.session_id",
        "session.session_id",
      )
      .select(["session.transcript_updated_at", "rewrite.generation"])
      .where("session.session_id", "=", sessionId),
  );
  if (!session) {
    return undefined;
  }
  const query = kysely
    .selectFrom("transcript_events")
    .select(["event_json", "seq", "created_at"])
    .where("session_id", "=", sessionId);
  const read = prepareSqliteQuerySync<number, InferResult<typeof query>[number]>(db, (parameter) =>
    query.where(
      "seq",
      "=",
      parameter((seq) => seq),
    ),
  );
  return {
    sessionId,
    transcriptGeneration: session.generation,
    transcriptUpdatedAt: session.transcript_updated_at,
    rows: () => iterateSqliteQuerySync(db, query.orderBy("seq", "asc")),
    row: (seq) => read(seq).rows[0],
  };
}

function visitProjectionSource(
  source: SessionTranscriptProjectionSource,
  visitor: Parameters<typeof visitSessionTranscriptProjection>[2],
): PreparedSessionTranscriptProjectionMetadata | undefined {
  let sourceIndexedSeq = -1;
  const tree = scanSessionTranscriptTree(
    (function* () {
      for (const row of source.rows()) {
        sourceIndexedSeq = row.seq;
        const event: unknown = JSON.parse(row.event_json);
        const navigation: Record<string, unknown> & { seq: number } = { seq: row.seq };
        if (isRecord(event)) {
          // Preserve own-property presence, including malformed controls, without retaining
          // message/tool/compaction payloads in the ancestry graph.
          for (const key of [
            "type",
            "id",
            "parentId",
            "targetId",
            "appendParentId",
            "appendMode",
          ]) {
            if (Object.hasOwn(event, key)) {
              navigation[key] = event[key];
            }
          }
        }
        yield navigation;
      }
    })(),
  );
  if (sourceIndexedSeq < 0) {
    return undefined;
  }
  const visiblePath = selectSessionTranscriptTreePathNodes(tree, tree.leafId);
  const rows =
    visiblePath.length > 0
      ? (function* () {
          for (const node of visiblePath) {
            const row = source.row(node.entry.seq);
            if (row) {
              yield row;
            }
          }
        })()
      : tree.hasLeafControl
        ? []
        : source.rows();
  let activeEventCount = 0;
  let activeMessageCount = 0;
  for (const row of rows) {
    const event: unknown = JSON.parse(row.event_json);
    const indexed = extractTranscriptIndexEntry(event, row.created_at);
    if (indexed) {
      visitor.ftsRow(indexed);
    }
    if (!shouldProjectActiveEvent(event)) {
      continue;
    }
    const projectsMessage = hasTranscriptMessage(event);
    visitor.activeRow({
      activePosition: activeEventCount++,
      contextEligible: transcriptEventContextEligibility(event),
      eventSeq: row.seq,
      messagePosition: projectsMessage ? activeMessageCount++ : null,
    });
  }
  return {
    activeEventCount,
    activeMessageCount,
    leafEventId: tree.appendParentId,
    sessionId: source.sessionId,
    sourceHasInvalidLeafControl: tree.hasInvalidLeafControl,
    sourceIndexedSeq,
    sourceTranscriptGeneration: source.transcriptGeneration,
    sourceTranscriptUpdatedAt: source.transcriptUpdatedAt,
  };
}

function prepareProjectionSource(
  source: SessionTranscriptProjectionSource,
): PreparedSessionTranscriptProjection | undefined {
  const activeRows: PreparedSessionTranscriptProjection["activeRows"] = [];
  const ftsRows: TranscriptIndexEntry[] = [];
  const metadata = visitProjectionSource(source, {
    activeRow: (row) => activeRows.push(row),
    ftsRow: (row) => ftsRows.push(row),
  });
  return metadata ? { ...metadata, activeRows, ftsRows } : undefined;
}

/** The worker owns these ordered raw rows; memory-backed transcripts never reopen a path. */
export function prepareMemorySessionTranscriptProjection(
  sessionId: string,
  transcriptUpdatedAt: number | null,
  rows: ReadonlyMap<number, SessionTranscriptProjectionRow>,
  transcriptGeneration: string | null = null,
): PreparedSessionTranscriptProjection | undefined {
  return prepareProjectionSource({
    sessionId,
    transcriptGeneration,
    transcriptUpdatedAt,
    rows: () => rows.values(),
    row: (seq) => rows.get(seq),
  });
}

/** Reads and resolves one projection on a worker-owned SQLite snapshot. */
export function prepareSessionTranscriptProjection(
  db: DatabaseSync,
  sessionId: string,
): PreparedSessionTranscriptProjection | undefined {
  return runSqliteDeferredTransactionSync(
    db,
    () => {
      const source = readProjectionSource(db, sessionId);
      return source ? prepareProjectionSource(source) : undefined;
    },
    {
      databaseLabel: "agent transcript projection",
      operationLabel: "sessions.transcript-index.prepare",
    },
  );
}

function readProjectionSourceSnapshot(
  db: DatabaseSync,
  sessionId: string,
): TranscriptProjectionSourceSnapshot {
  const kysely = getProjectionKysely(db);
  const session = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("session_windows as session")
      .leftJoin(
        "transcript_rewrite_watermarks as rewrite",
        "rewrite.session_id",
        "session.session_id",
      )
      .select(["session.transcript_updated_at", "rewrite.generation"])
      .where("session.session_id", "=", sessionId),
  );
  const latest = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("transcript_events")
      .select("seq")
      .where("session_id", "=", sessionId)
      .orderBy("seq", "desc")
      .limit(1),
  );
  return {
    generation: session?.generation ?? null,
    latestSeq: latest?.seq,
    transcriptUpdatedAt: session?.transcript_updated_at ?? null,
  };
}

function sourceSnapshotMatches(
  snapshot: TranscriptProjectionSourceSnapshot,
  plan: PreparedSessionTranscriptProjectionMetadata,
): boolean {
  return (
    snapshot.generation === plan.sourceTranscriptGeneration &&
    snapshot.latestSeq === plan.sourceIndexedSeq &&
    snapshot.transcriptUpdatedAt === plan.sourceTranscriptUpdatedAt
  );
}

function projectionTailFitsCatchUpBounds(
  db: DatabaseSync,
  plan: PreparedSessionTranscriptProjectionMetadata,
  snapshot: TranscriptProjectionSourceSnapshot,
): boolean {
  if (
    plan.sourceTranscriptGeneration === null ||
    snapshot.generation !== plan.sourceTranscriptGeneration ||
    snapshot.latestSeq === undefined ||
    snapshot.latestSeq < plan.sourceIndexedSeq
  ) {
    return false;
  }
  const tailRowCount = snapshot.latestSeq - plan.sourceIndexedSeq;
  if (tailRowCount > PROJECTION_FINALIZE_TAIL_ROWS) {
    return false;
  }
  const sizeRows = executeSqliteQuerySync(
    db,
    getProjectionKysely(db)
      .selectFrom("transcript_events")
      .select(["seq", transcriptEventStoredByteLength()])
      .where("session_id", "=", plan.sessionId)
      .where("seq", ">", plan.sourceIndexedSeq)
      .orderBy("seq", "asc")
      .limit(PROJECTION_FINALIZE_TAIL_ROWS + 1),
  ).rows;
  return (
    sizeRows.length === tailRowCount &&
    (sizeRows.at(-1)?.seq ?? plan.sourceIndexedSeq) === snapshot.latestSeq &&
    sizeRows.reduce((total, row) => total + row.event_bytes, 0) <= PROJECTION_FINALIZE_TAIL_BYTES
  );
}

function projectionClaimIsOwned(db: DatabaseSync, sessionId: string, claimId: number): boolean {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getProjectionKysely(db)
      .selectFrom("session_transcript_index_state")
      .select(["needs_rebuild", "updated_at"])
      .where("session_id", "=", sessionId),
  );
  return row?.needs_rebuild !== 0 && row?.updated_at === claimId;
}

/** Claims a prepared snapshot. Later chunks publish only while this claim remains current. */
export function claimPreparedSessionTranscriptProjectionInTransaction(
  db: DatabaseSync,
  plan: PreparedSessionTranscriptProjectionMetadata,
  claimId: number,
): boolean {
  const sourceSnapshot = readProjectionSourceSnapshot(db, plan.sessionId);
  const exactSnapshot = sourceSnapshotMatches(sourceSnapshot, plan);
  if (
    !exactSnapshot &&
    (plan.sourceHasInvalidLeafControl || !projectionTailFitsCatchUpBounds(db, plan, sourceSnapshot))
  ) {
    return false;
  }
  const kysely = getProjectionKysely(db);
  const current = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("session_transcript_index_state")
      .select(["indexed_seq", "needs_rebuild"])
      .where("session_id", "=", plan.sessionId),
  );
  if (
    current?.needs_rebuild === 0 &&
    current.indexed_seq === sourceSnapshot.latestSeq &&
    !hasUnclassifiedSessionTranscriptEvents(db, plan.sessionId)
  ) {
    return false;
  }
  executeSqliteQuerySync(
    db,
    kysely
      .insertInto("session_transcript_index_state")
      .values({
        active_event_count: 0,
        active_message_count: 0,
        indexed_seq: -1,
        leaf_event_id: null,
        needs_rebuild: 1,
        session_id: plan.sessionId,
        updated_at: claimId,
      })
      .onConflict((conflict) =>
        conflict.column("session_id").doUpdateSet({
          active_event_count: 0,
          active_message_count: 0,
          indexed_seq: -1,
          leaf_event_id: null,
          needs_rebuild: 1,
          updated_at: claimId,
        }),
      ),
  );
  return true;
}

/** Deletes old rows in bounded rowid batches while the prepared claim is current. */
export function deletePreparedSessionTranscriptProjectionChunkInTransaction(
  db: DatabaseSync,
  params: { claimId: number; maxRowsPerTable: number; sessionId: string },
): ProjectionDeleteChunkResult {
  if (!projectionClaimIsOwned(db, params.sessionId, params.claimId)) {
    return { hasMore: false, owned: false };
  }
  // Hidden rowid batching is the narrow SQLite primitive that keeps each
  // writer transaction bounded for both ordinary and FTS5 projection rows.
  const kysely = getProjectionKysely(db);
  const active = Number(
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("session_transcript_active_events")
        .where(
          "rowid",
          "in",
          kysely
            .selectFrom("session_transcript_active_events")
            .select("rowid")
            .where("session_id", "=", params.sessionId)
            .limit(params.maxRowsPerTable),
        ),
    ).numAffectedRows ?? 0n,
  );
  const fts = Number(
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("session_transcript_fts")
        .where(
          "rowid",
          "in",
          kysely
            .selectFrom("session_transcript_fts")
            .select("rowid")
            .where("session_id", "=", params.sessionId)
            .limit(params.maxRowsPerTable),
        ),
    ).numAffectedRows ?? 0n,
  );
  return {
    hasMore: active === params.maxRowsPerTable || fts === params.maxRowsPerTable,
    owned: true,
  };
}

/** Appends one bounded projection chunk while its claim remains current. */
export function appendPreparedSessionTranscriptProjectionChunkInTransaction(
  db: DatabaseSync,
  params: {
    activeRows?: PreparedSessionTranscriptProjection["activeRows"];
    claimId: number;
    ftsRows?: PreparedSessionTranscriptProjection["ftsRows"];
    sessionId: string;
  },
): boolean {
  if (!projectionClaimIsOwned(db, params.sessionId, params.claimId)) {
    return false;
  }
  insertPreparedSessionTranscriptProjectionRows(db, params);
  return true;
}

function insertPreparedSessionTranscriptProjectionRows(
  db: DatabaseSync,
  params: {
    activeRows?: PreparedSessionTranscriptProjection["activeRows"];
    ftsRows?: PreparedSessionTranscriptProjection["ftsRows"];
    sessionId: string;
  },
): void {
  const kysely = getProjectionKysely(db);
  if (params.activeRows && params.activeRows.length > 0) {
    executeSqliteQuerySync(
      db,
      kysely.insertInto("session_transcript_active_events").values(
        params.activeRows.map((row) => ({
          active_position: row.activePosition,
          context_eligible: row.contextEligible,
          event_seq: row.eventSeq,
          message_position: row.messagePosition,
          session_id: params.sessionId,
        })),
      ),
    );
  }
  if (params.ftsRows && params.ftsRows.length > 0) {
    executeSqliteQuerySync(
      db,
      kysely.insertInto("session_transcript_fts").values(
        params.ftsRows.map((row) => ({
          message_id: row.messageId,
          role: row.role,
          session_id: params.sessionId,
          text: row.text,
          timestamp: row.timestamp,
        })),
      ),
    );
  }
}

function prepareProjectionTailCatchUp(
  db: DatabaseSync,
  plan: PreparedSessionTranscriptProjectionMetadata,
  snapshot: TranscriptProjectionSourceSnapshot,
): PreparedSessionTranscriptProjection | undefined {
  const latestSeq = snapshot.latestSeq;
  if (
    plan.sourceHasInvalidLeafControl ||
    latestSeq === undefined ||
    !projectionTailFitsCatchUpBounds(db, plan, snapshot)
  ) {
    return undefined;
  }
  const rows = executeSqliteQuerySync(
    db,
    getProjectionKysely(db)
      .selectFrom("transcript_events")
      .select(["event_json", "seq", "created_at"])
      .where("session_id", "=", plan.sessionId)
      .where("seq", ">", plan.sourceIndexedSeq)
      .where("seq", "<=", latestSeq)
      .orderBy("seq", "asc"),
  ).rows;
  const activeRows: PreparedSessionTranscriptProjection["activeRows"] = [];
  const ftsRows: PreparedSessionTranscriptProjection["ftsRows"] = [];
  let cursor: SessionTranscriptProjectionCursor = {
    activeEventCount: plan.activeEventCount,
    activeMessageCount: plan.activeMessageCount,
    indexedSeq: plan.sourceIndexedSeq,
    leafEventId: plan.leafEventId,
  };
  for (const row of rows) {
    const event: unknown = JSON.parse(row.event_json);
    if (changesPriorProjectionVisibility(event)) {
      return undefined;
    }
    const append = prepareSessionTranscriptProjectionAppend({
      createdAt: row.created_at,
      cursor,
      event,
      eventId: readCanonicalEventId(event),
      seq: row.seq,
    });
    if (!append) {
      return undefined;
    }
    cursor = append.cursor;
    if (append.activeRow) {
      activeRows.push(append.activeRow);
    }
    if (append.ftsRow) {
      ftsRows.push(append.ftsRow);
    }
  }
  return {
    ...plan,
    activeEventCount: cursor.activeEventCount,
    activeMessageCount: cursor.activeMessageCount,
    activeRows,
    ftsRows,
    leafEventId: cursor.leafEventId,
    sourceIndexedSeq: cursor.indexedSeq,
    sourceTranscriptUpdatedAt: snapshot.transcriptUpdatedAt,
  };
}

/** Publishes one current snapshot, catching up a bounded append-only tail. */
export function finalizePreparedSessionTranscriptProjectionInTransaction(
  db: DatabaseSync,
  plan: PreparedSessionTranscriptProjectionMetadata,
  claimId: number,
): boolean {
  if (!projectionClaimIsOwned(db, plan.sessionId, claimId)) {
    return false;
  }
  const baseActiveRows = executeSqliteQueryTakeFirstSync(
    db,
    getProjectionKysely(db)
      .selectFrom("session_transcript_active_events")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("session_id", "=", plan.sessionId),
  );
  if (
    baseActiveRows?.count !== plan.activeEventCount ||
    hasUnclassifiedSessionTranscriptEvents(db, plan.sessionId)
  ) {
    return false;
  }
  const snapshot = readProjectionSourceSnapshot(db, plan.sessionId);
  const exactSnapshot = sourceSnapshotMatches(snapshot, plan);
  const catchUpPlan = exactSnapshot ? undefined : prepareProjectionTailCatchUp(db, plan, snapshot);
  if (!exactSnapshot && !catchUpPlan) {
    return false;
  }
  const finalPlan = catchUpPlan ?? plan;
  if (catchUpPlan) {
    insertPreparedSessionTranscriptProjectionRows(db, {
      activeRows: catchUpPlan.activeRows,
      ftsRows: catchUpPlan.ftsRows,
      sessionId: catchUpPlan.sessionId,
    });
  }
  executeSqliteQuerySync(
    db,
    getProjectionKysely(db)
      .updateTable("session_transcript_index_state")
      .set({
        active_event_count: finalPlan.activeEventCount,
        active_message_count: finalPlan.activeMessageCount,
        indexed_seq: finalPlan.sourceIndexedSeq,
        leaf_event_id: finalPlan.leafEventId,
        needs_rebuild: 0,
        updated_at: Date.now(),
      })
      .where("session_id", "=", finalPlan.sessionId)
      .where("needs_rebuild", "!=", 0)
      .where("updated_at", "=", claimId),
  );
  return true;
}
