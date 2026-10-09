import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionTranscriptSourceCursor,
  SessionTranscriptSourcePageOptions,
} from "../../gateway/session-transcript-read.types.js";
import {
  SOURCE_PAGE_MAX_BYTES,
  SOURCE_PAGE_MAX_MESSAGES,
} from "../../gateway/session-transcript-source-pages.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  positionTranscriptDisplayEvents,
  readTranscriptDisplaySource,
} from "./session-accessor.sqlite-display-position.js";
import {
  isVisibleHistoryNonMessageEvent,
  parseStoredTranscriptEvent,
} from "./session-accessor.sqlite-history-interval.js";
import {
  readActiveTranscriptCoordinate,
  resolveVisibleHistoryEventCount,
} from "./session-accessor.sqlite-history-projection.js";
import {
  getActiveTranscriptKysely,
  readSnapshotEventRows,
  type CurrentTranscriptProjection,
  type SessionTranscriptMessageEvent,
} from "./session-accessor.sqlite-projection-read.js";
import { resolveTranscriptBoundaryWindow } from "./session-accessor.sqlite-reset-window.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import { readTranscriptPayload } from "./transcript-payload.js";

type SqliteSourceCursor = Exclude<SessionTranscriptSourceCursor, { kind: "archive" }>;

/** Page indexed positions, including hidden controls, without rebuilding a full marker map. */
export function readSessionTranscriptSourcePageFromProjection(
  projection: CurrentTranscriptProjection,
  options: SessionTranscriptSourcePageOptions,
) {
  if (options.cursor?.kind === "archive") {
    throw new Error("Archive source cursors require the archive reader");
  }
  const db = getActiveTranscriptKysely(projection.database);
  const sessionId = projection.resolved.sessionId;
  const window = resolveTranscriptBoundaryWindow(projection);
  const activeEventCount =
    options.cursor?.snapshot.activeEventCount ?? projection.state.activeEventCount;
  const tail = readActiveTranscriptCoordinate(projection, { activePosition: activeEventCount - 1 });
  const snapshot = options.cursor?.snapshot ?? {
    indexedSeq: projection.state.indexedSeq,
    activeEventCount,
    totalMessages: resolveVisibleHistoryEventCount(projection),
    generation: projection.generation,
    tailEventSeq: tail?.event_seq,
    resetSeq: window?.boundarySeq ?? null,
  };
  // The physical tail fences invisible ancestors too; a visible anchor alone cannot protect cleanup.
  if (
    options.cursor &&
    (snapshot.generation !== projection.generation ||
      snapshot.indexedSeq > projection.state.indexedSeq ||
      snapshot.tailEventSeq !== tail?.event_seq ||
      snapshot.resetSeq !== (window?.boundarySeq ?? null))
  ) {
    throw new SessionTranscriptProjectionUnavailableError(sessionId, "window-changed");
  }
  // Let the archive owner select an empty source before spending this call's budget on branches.
  if (!options.cursor && snapshot.totalMessages === 0) {
    return {
      events: [],
      snapshot,
      nextCursor: options.includeOffPathMessages
        ? { kind: "off-path" as const, position: -1, messageSeq: 0, snapshot }
        : undefined,
    };
  }
  const kept = window?.keptMessagePositions ?? [];
  let cursor: SqliteSourceCursor | undefined = options.cursor ?? {
    kind: kept.length > 0 ? "kept" : "active",
    position: kept.length > 0 ? 0 : (window?.boundaryActivePosition ?? 0),
    messageSeq: 0,
    snapshot,
  };
  const activeEvents: SessionTranscriptMessageEvent[] = [];
  const offPathEvents: SessionTranscriptMessageEvent[] = [];
  let consumed = 0;
  let bytes = 0;
  while (cursor && consumed < SOURCE_PAGE_MAX_MESSAGES) {
    const kind: SqliteSourceCursor["kind"] = cursor.kind;
    const remaining = SOURCE_PAGE_MAX_MESSAGES - consumed;
    const keptPositions =
      kind === "kept" ? kept.slice(cursor.position, cursor.position + remaining) : [];
    const active = db
      .selectFrom("session_transcript_active_events as active")
      .crossJoin("transcript_events as event")
      .whereRef("event.session_id", "=", "active.session_id")
      .whereRef("event.seq", "=", "active.event_seq")
      .select([
        "event.seq",
        "active.active_position as position",
        "active.message_position",
        transcriptEventReadBytesSql("event").as("bytes"),
      ])
      .where("active.session_id", "=", sessionId);
    const query =
      kind === "off-path"
        ? db
            .selectFrom("transcript_events as event")
            .select([
              "event.seq",
              "event.seq as position",
              (eb) => eb.val(null).as("message_position"),
              transcriptEventReadBytesSql("event").as("bytes"),
            ])
            .where("event.session_id", "=", sessionId)
            .where("event.seq", ">", cursor.position)
            .where("event.seq", "<=", snapshot.indexedSeq)
            .where((eb) =>
              eb.not(
                eb.exists(
                  eb
                    .selectFrom("session_transcript_active_events as active")
                    .select("active.event_seq")
                    .whereRef("active.session_id", "=", "event.session_id")
                    .whereRef("active.event_seq", "=", "event.seq")
                    .where("active.active_position", "<", snapshot.activeEventCount),
                ),
              ),
            )
            .orderBy("event.seq", "asc")
        : kind === "kept"
          ? active
              .where("active.message_position", "in", keptPositions)
              .orderBy("active.message_position", "asc")
          : active
              .where("active.active_position", ">=", cursor.position)
              .where("active.active_position", "<", snapshot.activeEventCount)
              .orderBy("active.active_position", "asc");
    const rows =
      kind === "kept" && keptPositions.length === 0
        ? []
        : executeSqliteQuerySync(projection.database.db, query.limit(remaining)).rows;
    let admitted = 0;
    for (const row of rows) {
      if (row.bytes + 1 > SOURCE_PAGE_MAX_BYTES) {
        throw new Error(
          `Transcript source message exceeds the ${SOURCE_PAGE_MAX_BYTES}-byte page limit`,
        );
      }
      if (bytes + row.bytes + 1 > SOURCE_PAGE_MAX_BYTES) {
        break;
      }
      bytes += row.bytes + 1;
      admitted++;
    }
    const selected = rows.slice(0, admitted);
    const payloads = new Map(
      selected.length === 0
        ? []
        : readSnapshotEventRows(
            projection,
            selected.map((row) => row.seq),
          ).map((row) => [row.seq, parseStoredTranscriptEvent(readTranscriptPayload(row))]),
    );
    let messageSeq: number = cursor.messageSeq;
    for (const row of selected) {
      const event = payloads.get(row.seq);
      if (
        kind === "off-path" ||
        row.message_position !== null ||
        (isRecord(event) && isVisibleHistoryNonMessageEvent(event))
      ) {
        const entry = {
          event,
          eventSeq: row.seq,
          seq: kind === "off-path" ? row.seq + 1 : ++messageSeq,
        };
        (kind === "off-path" ? offPathEvents : activeEvents).push(entry);
      }
    }
    consumed += admitted;
    const last = selected.at(-1);
    const position: number =
      kind === "kept"
        ? cursor.position +
          (admitted < rows.length
            ? keptPositions.indexOf(rows[admitted]!.message_position!)
            : keptPositions.length)
        : last
          ? last.position + (kind === "off-path" ? 0 : 1)
          : cursor.position;
    cursor = { kind, position, messageSeq, snapshot };
    if (admitted < rows.length) {
      break;
    }
    if (kind === "kept" && position >= kept.length) {
      cursor = {
        kind: "active",
        position: window?.boundaryActivePosition ?? 0,
        snapshot,
        messageSeq,
      };
    } else if (
      kind === "active" &&
      (rows.length < remaining || position >= snapshot.activeEventCount)
    ) {
      cursor = options.includeOffPathMessages
        ? { kind: "off-path", position: -1, snapshot, messageSeq }
        : undefined;
    } else if (kind === "off-path" && rows.length < remaining) {
      cursor = undefined;
    }
  }
  // Position only active rows: off-path ordinals deliberately retain their raw sequence contract.
  const positioned = positionTranscriptDisplayEvents(
    projection,
    readTranscriptDisplaySource(projection),
    activeEvents,
    snapshot.indexedSeq,
  );
  return {
    events: [...positioned, ...offPathEvents],
    snapshot,
    ...(cursor ? { nextCursor: cursor } : {}),
  };
}
