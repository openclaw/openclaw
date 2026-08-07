// Bounded tail reads materialize only payloads that fit the caller's byte budget.
import { sql } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { resolveSqliteTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import { MAX_VISIBLE_MESSAGE_MAX_MESSAGES } from "./session-accessor.sqlite-visible-cursor.js";
import type { SessionTranscriptProjectionState } from "./session-transcript-index.js";

type BoundedTailDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "session_transcript_active_events" | "transcript_events"
>;

type BoundedTailProjection = {
  database: OpenClawAgentDatabase;
  resolved: ReturnType<typeof resolveSqliteTranscriptReadScope>;
  state: SessionTranscriptProjectionState;
};

type BoundedTailMessageEvent = {
  event: TranscriptEvent;
  seq: number;
};

type BoundedTailPage = {
  activeLeafEntryId?: string | null;
  events: BoundedTailMessageEvent[];
  scannedMessages: number;
  serializedBytes: number;
  totalMessages: number;
};

type BoundedTailVisibility<Projection> = {
  resolvePositionRange: (projection: Projection, start: number, endExclusive: number) => number[];
  resolvePositions: (projection: Projection) => { total: number };
};

function getBoundedTailKysely(database: OpenClawAgentDatabase) {
  return getNodeSqliteKysely<BoundedTailDatabase>(database.db);
}

function parseMessageEventRow(row: {
  event_json: string;
  message_position: number | null;
}): BoundedTailMessageEvent {
  if (row.message_position === null) {
    throw new Error("Active transcript message row is missing its message position");
  }
  return {
    event: JSON.parse(row.event_json) as TranscriptEvent,
    seq: row.message_position + 1,
  };
}

export function readBoundedMessageTailPageFromProjection<Projection extends BoundedTailProjection>(
  projection: Projection,
  options: { maxBytes: number; maxMessages: number; offset: number },
  visibility: BoundedTailVisibility<Projection>,
): BoundedTailPage {
  const visible = visibility.resolvePositions(projection);
  const totalMessages = visible.total;
  const offset = Math.min(
    Math.max(0, Math.floor(Number.isFinite(options.offset) ? options.offset : 0)),
    totalMessages,
  );
  const maxMessages = Math.min(
    MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
    Math.max(0, Math.floor(Number.isFinite(options.maxMessages) ? options.maxMessages : 0)),
  );
  const maxBytes = Math.max(
    0,
    Math.floor(Number.isFinite(options.maxBytes) ? options.maxBytes : 0),
  );
  const endExclusive = Math.max(0, totalMessages - offset);
  const start = Math.max(0, endExclusive - maxMessages);
  const positions = visibility.resolvePositionRange(projection, start, endExclusive);
  if (positions.length === 0 || maxBytes === 0) {
    return {
      activeLeafEntryId: projection.state.leafEventId,
      events: [],
      scannedMessages: positions.length,
      serializedBytes: 0,
      totalMessages,
    };
  }
  const db = getBoundedTailKysely(projection.database);
  const metadata = executeSqliteQuerySync(
    projection.database.db,
    db
      .selectFrom("session_transcript_active_events as active")
      .innerJoin("transcript_events as event", (join) =>
        join
          .onRef("event.session_id", "=", "active.session_id")
          .onRef("event.seq", "=", "active.event_seq"),
      )
      .select([
        "active.message_position",
        /* kysely-allow-raw: byte budget covers the exact newline-terminated JSON event. */
        sql<number>`LENGTH(CAST(event.event_json AS BLOB)) + 1`.as("serialized_bytes"),
      ])
      .where("active.session_id", "=", projection.resolved.sessionId)
      .where("active.message_position", "in", positions)
      .orderBy("active.message_position", "desc"),
  ).rows;
  const selectedPositions: number[] = [];
  let serializedBytes = 0;
  for (const row of metadata) {
    if (row.message_position === null || serializedBytes + row.serialized_bytes > maxBytes) {
      continue;
    }
    selectedPositions.push(row.message_position);
    serializedBytes += row.serialized_bytes;
  }
  const events =
    selectedPositions.length === 0
      ? []
      : executeSqliteQuerySync(
          projection.database.db,
          db
            .selectFrom("session_transcript_active_events as active")
            .innerJoin("transcript_events as event", (join) =>
              join
                .onRef("event.session_id", "=", "active.session_id")
                .onRef("event.seq", "=", "active.event_seq"),
            )
            .select(["active.message_position", "event.event_json"])
            .where("active.session_id", "=", projection.resolved.sessionId)
            .where("active.message_position", "in", selectedPositions)
            .orderBy("active.message_position", "asc"),
        ).rows.map(parseMessageEventRow);
  return {
    activeLeafEntryId: projection.state.leafEventId,
    events,
    scannedMessages: positions.length,
    serializedBytes,
    totalMessages,
  };
}
