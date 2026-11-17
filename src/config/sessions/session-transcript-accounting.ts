import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import {
  readProjectionTranscriptPayload,
  selectActiveTranscriptEventRows,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import { readVisibleTranscriptStats } from "./session-accessor.sqlite-reset-window.js";
import {
  readSessionTranscriptAccountingTail,
  selectSessionTranscriptAccountingTail,
} from "./session-transcript-accounting-policy.js";
import {
  SQLITE_USAGE_TAIL_MAX_EVENTS,
  type SessionTranscriptAccountingOptions,
  type SessionTranscriptAccountingSnapshot,
} from "./session-transcript-accounting.types.js";
import {
  projectTranscriptNavigationForReadSql,
  readTranscriptNavigation,
} from "./session-transcript-navigation.js";
import { transcriptEventNavigationSql } from "./transcript-payload.js";

function readAccountingTail(
  projection: CurrentTranscriptProjection,
  options: SessionTranscriptAccountingOptions,
): SessionTranscriptAccountingSnapshot {
  const query = selectActiveTranscriptEventRows(projection.database)
    .where("active.session_id", "=", projection.resolved.sessionId)
    .where("active.context_eligible", "=", 1)
    .orderBy("active.active_position", "desc");
  const candidates = Array.from(
    iterateSqliteQuerySync(
      projection.database.db,
      query
        .select("active.active_position")
        .select((eb) => {
          const navigation = projectTranscriptNavigationForReadSql(
            projection.database.db,
            transcriptEventNavigationSql(projection.database.db, "event"),
          );
          // SQLite treats literal NUL as an end marker, but JSON.parse rejects it.
          // Do not let compact projection hide corrupted identity bytes from accounting.
          return (
            isPostgresSqlConnection(projection.database.db)
              ? navigation
              : eb
                  .case()
                  .when(
                    eb.fn<number>("instr", [
                      eb.ref("event.event_json"),
                      eb.fn<string>("char", [eb.val(0)]),
                    ]),
                    ">",
                    0,
                  )
                  .then(null)
                  .else(navigation)
                  .end()
          ).as("navigation");
        })
        .limit(SQLITE_USAGE_TAIL_MAX_EVENTS),
    ),
    (row) => {
      if (row.navigation === null) {
        throw new Error("Transcript accounting navigation is unavailable");
      }
      return { position: row.active_position, event: readTranscriptNavigation(row.navigation) };
    },
  );
  const selected = selectSessionTranscriptAccountingTail(
    candidates.toReversed(),
    (row) => row.event,
  );
  function* events(): Iterable<unknown> {
    if (selected.length === 0) {
      return;
    }
    // Keep the active-position index as the driver; sorting hydrated bodies defeats early exit.
    const reordered = selected.some(
      (row, index) => index > 0 && row.position <= selected[index - 1]!.position,
    );
    // Duplicate imported ids can put logical ancestors after their descendants on disk.
    // Buffer only that bounded exceptional path, then replay the tree owner's order.
    const buffered = reordered ? new Map<number, unknown>() : undefined;
    const payloads = query
      .where(
        "active.active_position",
        "in",
        selected.map((row) => row.position),
      )
      .select([
        "active.active_position",
        "event.seq",
        "event.event_json",
        "event.event_zstd",
        "event.event_utf8_bytes",
      ]);
    for (const row of iterateSqliteQuerySync(projection.database.db, payloads)) {
      const event: unknown = JSON.parse(readProjectionTranscriptPayload(projection, row, row.seq));
      if (buffered) {
        buffered.set(row.active_position, event);
      } else {
        yield event;
      }
    }
    if (buffered) {
      for (const row of selected.toReversed()) {
        if (!buffered.has(row.position)) {
          throw new Error("Transcript accounting path is incomplete");
        }
        yield buffered.get(row.position);
      }
    }
  }
  // Monotone paths validate only the needed suffix; exceptional ordering validates its bounded set.
  // Navigation and required-body failures still take the caller's conservative error path.
  return readSessionTranscriptAccountingTail(events(), options, candidates.length);
}

export function readSessionTranscriptAccountingFromProjection(
  projection: CurrentTranscriptProjection,
  params: SessionTranscriptAccountingOptions,
): SessionTranscriptAccountingSnapshot {
  const snapshot: SessionTranscriptAccountingSnapshot = {};
  try {
    if (params.includeByteSize) {
      const stats = readVisibleTranscriptStats(projection);
      snapshot.byteSize = stats.sizeBytes;
      snapshot.eventCount = stats.eventCount;
    }
    if (params.includeUsage || params.includeTurnTaint) {
      Object.assign(snapshot, readAccountingTail(projection, params));
    }
  } catch {
    if (params.includeTurnTaint) {
      snapshot.turnTainted = true;
    }
  }
  return snapshot;
}
