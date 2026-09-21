import type { DatabaseSync } from "node:sqlite";
import { sql, type InferResult, type RawBuilder } from "kysely";
import type { TranscriptDisplayPosition } from "../../chat/transcript-display-position.js";
import {
  getNodeSqliteKysely,
  prepareSqliteQueryIterator,
  prepareSqliteQuerySync,
  prepareSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import type { UnindexedHistoryControl } from "./session-accessor.sqlite-history-navigation.types.js";
import type { resolveSqliteTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import type { SessionTranscriptProjectionState } from "./session-transcript-index.js";

type ActiveTranscriptDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "session_transcript_active_events"
  | "session_transcript_cold_archives"
  | "transcript_rewrite_watermarks"
  | "session_transcript_index_state"
  | "transcript_event_identities"
  | "transcript_events"
>;

type TranscriptReadDatabase = Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">;

export type CurrentTranscriptProjection = {
  database: TranscriptReadDatabase;
  generation: string | undefined;
  hasUnindexedPrefix: boolean;
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

const EMPTY_PROJECTION_STATE: SessionTranscriptProjectionState = {
  activeEventCount: 0,
  activeMessageCount: 0,
  indexedSeq: -1,
  leafEventId: null,
  needsRebuild: false,
};

export function getActiveTranscriptKysely(database: TranscriptReadDatabase) {
  return getNodeSqliteKysely<ActiveTranscriptDatabase>(database.db);
}

export function parseActiveTranscriptMessageRow(row: {
  event_seq: number;
  event_json: string;
  message_position: number | null;
}): SessionTranscriptMessageEvent {
  if (row.message_position === null) {
    throw new Error("Active transcript message row is missing its message position");
  }
  return {
    // SAFETY: The active projection indexes serialized TranscriptEvent rows.
    event: JSON.parse(row.event_json) as TranscriptEvent,
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
  database: CurrentTranscriptProjection["database"],
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
  return query.select(["active.event_seq", "active.message_position", "event.event_json"]);
}

export function selectMessageMetadata(query: ReturnType<typeof selectMessageRows>) {
  return query
    .select([
      "active.message_position",
      /* kysely-allow-raw: byte caps include each event's JSONL newline. */
      sql<number>`OCTET_LENGTH(event.event_json) + 1`.as("serialized_bytes"),
    ])
    .$narrowType<{ message_position: number }>();
}

function createMessageRangeReaders(database: CurrentTranscriptProjection["database"]) {
  const metadata = (direction: "asc" | "desc") =>
    prepareSqliteQueryIterator<
      MessageRangeParameters,
      { message_position: number; serialized_bytes: number }
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
}

const messageRangeReaders = new WeakMap<
  DatabaseSync,
  ReturnType<typeof createMessageRangeReaders>
>();

export function getMessageRangeReaders(database: CurrentTranscriptProjection["database"]) {
  let readers = messageRangeReaders.get(database.db);
  if (!readers) {
    readers = createMessageRangeReaders(database);
    messageRangeReaders.set(database.db, readers);
  }
  return readers;
}

function buildProjectionSnapshotQuery(
  database: TranscriptReadDatabase,
  sessionId: RawBuilder<string>,
) {
  const db = getActiveTranscriptKysely(database);
  // The target survives empty and archived transcripts, which have no hot event rows.
  const target = db.selectNoFrom(sessionId.as("session_id")).as("target");
  return db
    .selectFrom(target)
    .leftJoin("session_transcript_index_state as state", "state.session_id", "target.session_id")
    .leftJoin(
      "transcript_rewrite_watermarks as watermark",
      "watermark.session_id",
      "target.session_id",
    )
    .select([
      "watermark.generation",
      "state.active_event_count",
      "state.active_message_count",
      "state.indexed_seq",
      "state.leaf_event_id",
      "state.needs_rebuild",
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
const projectionSnapshotReaders = new WeakMap<
  DatabaseSync,
  ReturnType<
    typeof prepareSqliteQuerySync<
      string,
      InferResult<ReturnType<typeof buildProjectionSnapshotQuery>>[number]
    >
  >
>();

function readProjectionSnapshot(database: TranscriptReadDatabase, sessionId: string) {
  let read = projectionSnapshotReaders.get(database.db);
  if (!read) {
    read = prepareSqliteQuerySync<
      string,
      InferResult<ReturnType<typeof buildProjectionSnapshotQuery>>[number]
    >(database.db, (parameter) =>
      buildProjectionSnapshotQuery(
        database,
        parameter((id) => id),
      ),
    );
    projectionSnapshotReaders.set(database.db, read);
  }
  const row = read(sessionId).rows[0]!;
  return {
    cold: Boolean(row.is_cold),
    generation: row.generation ?? undefined,
    hasUnclassified: Boolean(row.has_unclassified),
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
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      const snapshot = readProjectionSnapshot(database, resolved.sessionId);
      if (snapshot.cold) {
        throw new SessionTranscriptColdError(resolved.sessionId);
      }
      if (snapshot.latestSeq === null) {
        return {
          kind: "value" as const,
          value: read({
            database,
            generation: snapshot.generation,
            hasUnindexedPrefix: false,
            resolved,
            state: EMPTY_PROJECTION_STATE,
          }),
        };
      }
      if (
        snapshot.state &&
        !snapshot.state.needsRebuild &&
        snapshot.state.indexedSeq === snapshot.latestSeq &&
        !snapshot.hasUnclassified
      ) {
        return {
          kind: "value" as const,
          value: read({
            database,
            generation: snapshot.generation,
            hasUnindexedPrefix: snapshot.hasUnindexedPrefix,
            resolved,
            state: snapshot.state,
          }),
        };
      }
      return { kind: "unavailable" as const };
    },
    {
      databaseLabel: database.path,
      operationLabel: "sessions.history.read",
    },
  );
}
