import { sql, type InferResult, type RawBuilder } from "kysely";
import type { TranscriptDisplayPosition } from "../../chat/transcript-display-position.js";
import {
  createSqliteQueryCache,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  prepareSqliteQueryIterator,
  prepareSqliteQuerySync,
  prepareSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { captureSqliteReaderOwner } from "../../infra/sqlite-reader-lifecycle.js";
import { getSqliteReadScopeRevision } from "../../infra/sqlite-schema-facts.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { TranscriptReadWindow } from "../../sessions/transcript-read-window.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptContextVersion,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import type { UnindexedHistoryControl } from "./session-accessor.sqlite-history-navigation.types.js";
import type { resolveSqliteTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import { retainTranscriptContextFacts } from "./session-transcript-context-facts.js";
import type { SessionTranscriptProjectionState } from "./session-transcript-index.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import { readTranscriptPayload, type TranscriptPayloadRecord } from "./transcript-payload.js";

type ActiveTranscriptDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "session_transcript_active_events"
  | "session_transcript_cold_archives"
  | "transcript_rewrite_watermarks"
  | "session_transcript_index_state"
  | "session_windows"
  | "transcript_event_identities"
  | "transcript_events"
>;

type TranscriptReadDatabase = Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">;

export type CurrentTranscriptProjection = {
  database: TranscriptReadDatabase;
  generation: string | undefined;
  version: SessionTranscriptContextVersion;
  hasUnindexedPrefix: boolean;
  latestIndexedReset?: { active_position: number; event_type: "reset"; seq: number } | null;
  unindexedHistoryControls?: {
    coveredThrough: number;
    rows: readonly UnindexedHistoryControl[];
  };
  resolved: ReturnType<typeof resolveSqliteTranscriptReadScope>;
  state: SessionTranscriptProjectionState;
};

export type SessionTranscriptMessageEvent = {
  event: TranscriptEvent;
  eventSeq: number;
  seq: number;
  displayPosition?: TranscriptDisplayPosition;
};

export type SessionTranscriptMessageEventPage = {
  /** Source offset for the next older bounded page, independent of rendered message count. */
  olderOffset?: number;
  /** One source event exceeded a strict page byte limit and was skipped. */
  omittedOversized?: boolean;
  activeLeafEntryId?: string | null;
  deltaCursor?: string;
  displaySource?: string;
  readWindow?: TranscriptReadWindow;
  windowReset?: boolean;
  events: SessionTranscriptMessageEvent[];
  totalMessages: number;
};

export type SessionTranscriptMessageAnchorPage = SessionTranscriptMessageEventPage & {
  found: boolean;
  hasOverreadContext: boolean;
  offset: number;
};

export type SessionTranscriptBoundedMessageTailPage = SessionTranscriptMessageEventPage & {
  /** Role-matched individual oversized messages in the requested check range. */
  hasOversizedMessages?: boolean;
  // `events` may remain sparse for salvage callers; this count marks the
  // authoritative newest suffix before the first byte-budget omission.
  newestContiguousEventCount: number;
  scannedMessages: number;
  serializedBytes: number;
  snapshot: {
    boundarySeq?: number;
    generation?: string;
    indexedSeq: number;
  };
};

export type SessionTranscriptBoundedMessageTailOptions = {
  maxBytes: number;
  maxMessages: number;
  offset: number;
  readOnly?: boolean;
  oversizedMessageCheck?: { roles: readonly string[]; includeEarlier?: boolean };
};

const EMPTY_PROJECTION_STATE: SessionTranscriptProjectionState = {
  activeEventCount: 0,
  activeMessageCount: 0,
  indexedSeq: -1,
  leafEventId: null,
  needsRebuild: false,
};

export function getActiveTranscriptKysely(database: Pick<TranscriptReadDatabase, "db">) {
  return getNodeSqliteKysely<ActiveTranscriptDatabase>(database.db);
}

/** Materialize only physical events already selected in the caller's admitted snapshot. */
export function readSnapshotEventRows(
  projection: CurrentTranscriptProjection,
  eventSeqs: readonly number[],
) {
  const sessionId = projection.resolved.sessionId;
  const query = getActiveTranscriptKysely(projection.database)
    .selectFrom("transcript_events as event")
    .select(["event.seq", "event.event_json", "event.event_zstd", "event.event_utf8_bytes"])
    .where("event.session_id", "=", sessionId);
  return executeSqliteQuerySync(
    projection.database.db,
    query.where(
      "event.seq",
      "in",
      /* kysely-allow-raw: bind physical sequences already selected in this snapshot. */
      sql<number>`(SELECT value FROM json_each(${JSON.stringify(eventSeqs)}))`,
    ),
  ).rows;
}

export function parseActiveTranscriptMessageRow(
  row: Pick<TranscriptPayloadRecord, "event_json" | "event_zstd" | "event_utf8_bytes"> & {
    event_seq: number;
    message_position: number | null;
  },
): SessionTranscriptMessageEvent {
  if (row.message_position === null) {
    throw new Error("Active transcript message row is missing its message position");
  }
  return {
    // SAFETY: The active projection indexes serialized TranscriptEvent rows.
    event: JSON.parse(readTranscriptPayload(row)) as TranscriptEvent,
    eventSeq: row.event_seq,
    // Gateway cursors use the visible-message ordinal, matching the JSONL index.
    // Raw event seq includes headers/control rows and would make pages overlap.
    seq: row.message_position + 1,
  };
}

export type MessageRangeSelection =
  | { positions: number[] }
  | { start: number; endExclusive: number };

type MessageRangeParameters = { sessionId: string; start: number; endExclusive: number };

export function selectMessageRows(
  database: Pick<TranscriptReadDatabase, "db">,
  sessionId: string | RawBuilder<string>,
  selection:
    | { positions: number[] }
    | { start: number | RawBuilder<number>; endExclusive: number | RawBuilder<number> },
) {
  const query = getActiveTranscriptKysely(database)
    .selectFrom("session_transcript_active_events as active")
    .innerJoin("transcript_events as event", (join) =>
      join
        .onRef("event.session_id", "=", "active.session_id")
        .onRef("event.seq", "=", "active.event_seq"),
    )
    .where("active.session_id", "=", sessionId)
    .where("active.message_position", "is not", null)
    .orderBy("active.message_position", "asc");
  return "positions" in selection
    ? query.where(
        "active.message_position",
        "in",
        selection.positions.length <= 500
          ? selection.positions
          : getActiveTranscriptKysely(database)
              .selectFrom((eb) =>
                eb
                  .fn<{ value: number }>("json_each", [eb.val(JSON.stringify(selection.positions))])
                  .as("requested"),
              )
              .select("requested.value"),
      )
    : query
        .where("active.message_position", ">=", selection.start)
        .where("active.message_position", "<", selection.endExclusive);
}

export function selectMessagePayload(query: ReturnType<typeof selectMessageRows>) {
  return query.select([
    "active.event_seq",
    "active.message_position",
    "event.event_json",
    "event.event_zstd",
    "event.event_utf8_bytes",
  ]);
}

export function selectMessageMetadata(query: ReturnType<typeof selectMessageRows>) {
  return query
    .select([
      "active.event_seq",
      "active.message_position",
      /* kysely-allow-raw: byte caps include each event's JSONL newline. */
      sql<number>`${transcriptEventReadBytesSql("event")} + 1`.as("serialized_bytes"),
    ])
    .$narrowType<{ message_position: number }>();
}

const messageRangeReaders = createSqliteQueryCache((db) => {
  const database = { db };
  const metadata = (direction: "asc" | "desc") =>
    prepareSqliteQueryIterator<
      MessageRangeParameters,
      { event_seq: number; message_position: number; serialized_bytes: number }
    >(database.db, (parameter) =>
      selectMessageMetadata(
        selectMessageRows(
          database,
          parameter((params) => params.sessionId),
          {
            start: parameter((params) => params.start),
            endExclusive: parameter((params) => params.endExclusive),
          },
        )
          .clearOrderBy()
          .orderBy("active.message_position", direction),
      ),
    );
  return {
    latest: prepareSqliteQueryTakeFirstSync<
      MessageRangeParameters,
      Parameters<typeof parseActiveTranscriptMessageRow>[0]
    >(database.db, (parameter) =>
      selectMessagePayload(
        selectMessageRows(
          database,
          parameter((params) => params.sessionId),
          {
            start: parameter((params) => params.start),
            endExclusive: parameter((params) => params.endExclusive),
          },
        ),
      )
        .clearOrderBy()
        .orderBy("active.message_position", "desc")
        .limit(1),
    ),
    messages: prepareSqliteQueryIterator<
      MessageRangeParameters,
      Parameters<typeof parseActiveTranscriptMessageRow>[0]
    >(database.db, (parameter) =>
      selectMessagePayload(
        selectMessageRows(
          database,
          parameter((params) => params.sessionId),
          {
            start: parameter((params) => params.start),
            endExclusive: parameter((params) => params.endExclusive),
          },
        ),
      ),
    ),
    metadata: metadata("asc"),
    metadataDescending: metadata("desc"),
  };
});

export function getMessageRangeReaders(database: CurrentTranscriptProjection["database"]) {
  return messageRangeReaders(database.db);
}

function buildProjectionSnapshotQuery(
  database: Pick<TranscriptReadDatabase, "db">,
  sessionId: RawBuilder<string>,
) {
  const db = getActiveTranscriptKysely(database);
  // The target survives empty and archived transcripts, which have no hot event rows.
  const target = db.selectNoFrom(sessionId.as("session_id")).as("target");
  return db
    .selectFrom(target)
    .leftJoin("session_transcript_index_state as state", "state.session_id", "target.session_id")
    .leftJoin("session_windows as window", "window.session_id", "target.session_id")
    .leftJoin(
      "transcript_rewrite_watermarks as watermark",
      "watermark.session_id",
      "target.session_id",
    )
    .leftJoin("session_transcript_active_events as latest_reset", (join) =>
      join
        .onRef("latest_reset.session_id", "=", "target.session_id")
        .on("latest_reset.event_seq", "=", (eb) =>
          eb
            .selectFrom("transcript_event_identities as reset_identity")
            .innerJoin("session_transcript_active_events as reset_active", (resetJoin) =>
              resetJoin
                .onRef("reset_active.session_id", "=", "reset_identity.session_id")
                .onRef("reset_active.event_seq", "=", "reset_identity.seq"),
            )
            .select("reset_identity.seq")
            .whereRef("reset_identity.session_id", "=", "target.session_id")
            .where("reset_identity.event_type", "=", "reset")
            .orderBy("reset_identity.seq", "desc")
            .limit(1),
        ),
    )
    .select([
      "watermark.generation",
      "window.transcript_updated_at",
      "state.active_event_count",
      "state.active_message_count",
      "state.indexed_seq",
      "state.leaf_event_id",
      "state.needs_rebuild",
      "latest_reset.active_position as reset_active_position",
      "latest_reset.event_seq as reset_seq",
    ])
    .select((eb) => [
      eb
        .selectFrom("transcript_events")
        .select(({ fn }) => fn.max<number | null>("seq").as("latest_seq"))
        .whereRef("transcript_events.session_id", "=", "target.session_id")
        .as("latest_seq"),
      eb
        .exists(
          eb
            .selectFrom("session_transcript_cold_archives")
            .select("session_id")
            .whereRef("session_transcript_cold_archives.session_id", "=", "target.session_id"),
        )
        .as("is_cold"),
      eb
        .exists(
          eb
            .selectFrom("session_transcript_active_events")
            .select("session_id")
            .whereRef("session_transcript_active_events.session_id", "=", "target.session_id")
            .where("context_eligible", "is", null),
        )
        .as("has_unclassified"),
      eb
        .not(
          eb.exists(
            eb
              .selectFrom("transcript_event_identities as identity")
              .select("identity.seq")
              .whereRef("identity.session_id", "=", "target.session_id")
              .where(
                "identity.seq",
                "=",
                eb
                  .selectFrom("transcript_events as first_event")
                  .select("first_event.seq")
                  .whereRef("first_event.session_id", "=", "target.session_id")
                  .orderBy("first_event.seq", "asc")
                  .limit(1),
              ),
          ),
        )
        .as("has_unindexed_prefix"),
    ]);
}

// Cache compilation only; bindings and rows belong to each read snapshot.
const projectionSnapshotReader = createSqliteQueryCache((db) =>
  prepareSqliteQuerySync<
    string,
    InferResult<ReturnType<typeof buildProjectionSnapshotQuery>>[number]
  >(db, (parameter) =>
    buildProjectionSnapshotQuery(
      { db },
      parameter((id) => id),
    ),
  ),
);

function readProjectionSnapshot(database: TranscriptReadDatabase, sessionId: string) {
  const row = projectionSnapshotReader(database.db)(sessionId).rows[0]!;
  return {
    cold: Boolean(row.is_cold),
    generation: row.generation ?? undefined,
    updatedAt: row.transcript_updated_at ?? null,
    hasUnclassified: Boolean(row.has_unclassified),
    latestIndexedReset:
      typeof row.reset_seq === "number" && typeof row.reset_active_position === "number"
        ? {
            active_position: row.reset_active_position,
            event_type: "reset" as const,
            seq: row.reset_seq,
          }
        : null,
    hasUnindexedPrefix: Boolean(row.has_unindexed_prefix),
    latestSeq: row.latest_seq,
    ...(typeof row.indexed_seq === "number"
      ? {
          state: {
            activeEventCount: row.active_event_count ?? 0,
            activeMessageCount: row.active_message_count ?? 0,
            indexedSeq: row.indexed_seq,
            leafEventId: row.leaf_event_id,
            needsRebuild: row.needs_rebuild !== 0,
          },
        }
      : {}),
  };
}

/** Read one admitted connection without acquiring a writer or scheduling reconciliation. */
export function readCurrentProjectionSnapshot<T>(
  database: TranscriptReadDatabase,
  resolved: CurrentTranscriptProjection["resolved"],
  read: (projection: CurrentTranscriptProjection) => T,
) {
  const diagnostics: Record<string, string | number> = { sessionId: resolved.sessionId };
  const readerOperation = captureSqliteReaderOwner()?.operation;
  if (readerOperation) {
    diagnostics.readerOperation = readerOperation;
  }
  const readSnapshot = () => {
    const snapshot = readProjectionSnapshot(database, resolved.sessionId);
    if (snapshot.state) {
      diagnostics.activeEvents = snapshot.state.activeEventCount;
      diagnostics.activeMessages = snapshot.state.activeMessageCount;
      diagnostics.indexedSeq = snapshot.state.indexedSeq;
    }
    if (snapshot.cold) {
      throw new SessionTranscriptColdError(resolved.sessionId);
    }
    const version = {
      generation: snapshot.generation ?? null,
      rawSeq: snapshot.latestSeq,
      updatedAt: snapshot.updatedAt,
    };
    retainTranscriptContextFacts(
      database,
      resolved.sessionId,
      version,
      getSqliteReadScopeRevision(database.db),
      false,
    );
    const empty = snapshot.latestSeq === null;
    const state = empty ? EMPTY_PROJECTION_STATE : snapshot.state;
    if (
      !state ||
      state.needsRebuild ||
      (!empty && (state.indexedSeq !== snapshot.latestSeq || snapshot.hasUnclassified))
    ) {
      return { kind: "unavailable" as const };
    }
    return {
      kind: "value" as const,
      value: read({
        database,
        generation: snapshot.generation,
        version,
        hasUnindexedPrefix: !empty && snapshot.hasUnindexedPrefix,
        latestIndexedReset: empty ? null : snapshot.latestIndexedReset,
        resolved,
        state,
      }),
    };
  };
  return database.db.isTransaction
    ? readSnapshot()
    : runSqliteDeferredTransactionSync(database.db, readSnapshot, {
        databaseLabel: database.path,
        operationLabel: "sessions.history.read",
        diagnosticContext: diagnostics,
      });
}
