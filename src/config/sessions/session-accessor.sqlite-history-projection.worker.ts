import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import { engineIndexHint } from "../../infra/database-engine/index-hint.js";
import { registerNodeSqliteDisposeCallback } from "../../infra/kysely-sync-cache-state.js";
import { createSqliteQueryCache, executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { sqlPublicationAnchor } from "../../infra/sql-connection.js";
import { hasUncommittedSqliteWrites } from "../../infra/sqlite-schema-facts.js";
import { isVisibleHistoryNonMessageEventSql } from "./session-accessor.sqlite-history-interval.js";
import { buildVisibleHistoryProjection } from "./session-accessor.sqlite-history-projection.js";
import type {
  VisibleHistoryBoundary,
  VisibleHistoryProjection,
} from "./session-accessor.sqlite-history-projection.types.js";
import {
  getActiveTranscriptKysely,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import { prepareSessionTranscriptProjectionAppend } from "./session-transcript-projection-append.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import { transcriptEventResetNavigationSql } from "./transcript-payload.js";

type CachedHistoryProjection = {
  generation: string;
  state: CurrentTranscriptProjection["state"];
  history: VisibleHistoryProjection;
};

const historyProjections = createSqliteQueryCache((database) => {
  const sessions = new Map<string, CachedHistoryProjection>();
  registerNodeSqliteDisposeCallback(sqlPublicationAnchor(database), () => sessions.clear());
  return sessions;
});

function appendHistoryBoundaries(
  history: VisibleHistoryProjection,
  boundaries: Iterable<VisibleHistoryBoundary>,
) {
  for (const boundary of boundaries) {
    history.boundaries.push(boundary);
    history.boundariesById.set(boundary.eventId, boundary);
    history.boundariesBySeq.set(boundary.eventSeq, boundary);
  }
}

/** Replay only new navigation through the projection owner's ordinary-append classifier. */
function extendVisibleHistoryProjection(
  projection: CurrentTranscriptProjection,
  cached: CachedHistoryProjection,
): VisibleHistoryProjection | undefined {
  const database = projection.database;
  const db = getActiveTranscriptKysely(database);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events as event")
      .leftJoin("session_transcript_active_events as active", (join) =>
        join
          .onRef("active.session_id", "=", "event.session_id")
          .onRef("active.event_seq", "=", "event.seq"),
      )
      .leftJoin(
        db
          .selectFrom("transcript_event_identities")
          .select(["session_id", "event_id", "event_type", "seq"])
          .modifyEnd(engineIndexHint(database.db, "idx_agent_transcript_event_identity_sequence"))
          .as("identity"),
        (join) =>
          join
            .onRef("identity.session_id", "=", "event.session_id")
            .onRef("identity.seq", "=", "event.seq"),
      )
      .select((eb) => [
        "event.seq",
        "event.navigation_valid",
        "active.message_position",
        "identity.event_id",
        transcriptEventResetNavigationSql(database.db, "event").as("event_json"),
        isVisibleHistoryNonMessageEventSql(
          eb.ref("identity.event_type"),
          eb.ref("event.navigation_display"),
          eb.ref("event.navigation_custom_type"),
          eb.ref("event.navigation_valid"),
        ).as("visible"),
        /* kysely-allow-raw: retain the original byte cap without loading new message bodies. */
        sql<number>`${transcriptEventReadBytesSql("event")} + 1`.as("serialized_bytes"),
      ])
      .where("event.session_id", "=", projection.resolved.sessionId)
      .where("event.seq", ">", cached.state.indexedSeq)
      .where("event.seq", "<=", projection.state.indexedSeq)
      .orderBy("event.seq", "asc"),
  ).rows;
  let cursor = cached.state;
  const history = cached.history;
  const messageOffset = history.total - history.boundaries.length - cursor.activeMessageCount;
  const appended: VisibleHistoryBoundary[] = [];
  for (const row of rows) {
    // Exceptional legacy navigation retains the full reader's existing behavior.
    if (row.navigation_valid === 0) {
      return undefined;
    }
    const event: unknown = JSON.parse(row.event_json);
    if (!isRecord(event) || event.type === "reset") {
      return undefined;
    }
    // Reset navigation always includes a role envelope; the active owner records
    // whether the original event actually occupied a message slot.
    if (row.message_position === null) {
      delete event.message;
    }
    const append = prepareSessionTranscriptProjectionAppend({
      cursor,
      event,
      eventId: row.event_id,
      seq: row.seq,
      createdAt: 0,
    });
    if (!append) {
      return undefined;
    }
    cursor = { ...append.cursor, needsRebuild: false };
    if (row.visible) {
      const messagePosition = messageOffset + cursor.activeMessageCount;
      appended.push({
        displayPosition: messagePosition + history.boundaries.length + appended.length,
        eventId: row.event_id ?? "",
        eventSeq: row.seq,
        messagePosition,
        serializedBytes: row.serialized_bytes,
      });
    }
  }
  // Readers consume projections synchronously. Keep the committed prefix in place;
  // copying it here would make every ordinary append proportional to session size.
  appendHistoryBoundaries(history, appended);
  history.total += cursor.activeMessageCount - cached.state.activeMessageCount + appended.length;
  return history;
}

/** The admitted history worker retains committed metadata across read snapshots. */
export function resolveWorkerVisibleHistoryProjection(
  projection: CurrentTranscriptProjection,
): VisibleHistoryProjection {
  if (
    !projection.generation ||
    projection.hasUnindexedPrefix ||
    hasUncommittedSqliteWrites(projection.database.db)
  ) {
    return buildVisibleHistoryProjection(projection);
  }
  const sessions = historyProjections(projection.database.db);
  const key = JSON.stringify([projection.resolved.agentId, projection.resolved.sessionId]);
  const cached = sessions.get(key);
  let history: VisibleHistoryProjection | undefined;
  if (cached?.generation === projection.generation) {
    if (cached.state.indexedSeq === projection.state.indexedSeq) {
      return cached.history;
    }
    if (cached.state.indexedSeq < projection.state.indexedSeq) {
      history = extendVisibleHistoryProjection(projection, cached);
    }
  }
  history ??= buildVisibleHistoryProjection(projection);
  sessions.delete(key);
  sessions.set(key, {
    generation: projection.generation,
    state: { ...projection.state },
    history,
  });
  pruneMapToMaxSize(sessions, 16);
  return history;
}
