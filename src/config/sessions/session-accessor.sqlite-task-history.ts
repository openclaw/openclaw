import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import {
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import {
  readSessionTranscriptRunId,
  readSessionTranscriptFailureRunId,
} from "../../sessions/transcript-events.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  getActiveTranscriptKysely,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import type { SessionHistoryTranscriptBinding } from "./session-history-types.js";
import { projectSupportedTranscriptPayloadNavigationSql } from "./session-model-context-projection.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import {
  MAX_NAVIGATION_BYTES,
  readTranscriptStorageEncoding,
  transcriptEventJsonSql,
  transcriptEventNavigationSql,
} from "./transcript-payload.js";

/** Task membership follows the active branch, including failures before an assistant reply. */
export function readSessionTranscriptBindingFromProjection(
  projection: CurrentTranscriptProjection,
  run?: { id: string; maxBytes: number },
): SessionHistoryTranscriptBinding | undefined {
  resolveSqliteSessionTranscriptReadFence({
    database: projection.database,
    ...projection.resolved,
  });
  const { sessionId } = projection.resolved;
  const owner = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    getNodeSqliteKysely<Pick<DB, "session_windows">>(projection.database.db)
      .selectFrom("session_windows")
      .select("session_key")
      .where("session_id", "=", sessionId),
  );
  if (!owner) {
    return undefined;
  }
  if (run) {
    const db = getActiveTranscriptKysely(projection.database);
    const navigation = transcriptEventNavigationSql("event");
    const metadata = db
      .selectFrom("session_transcript_active_events as active")
      .innerJoin("transcript_events as event", (join) =>
        join
          .onRef("event.session_id", "=", "active.session_id")
          .onRef("event.seq", "=", "active.event_seq"),
      )
      .select("active.event_seq")
      .select(
        /* kysely-allow-raw: Keep the cached navigation or exact exceptional bytes bounded before canonical JSON parsing. */
        sql<string | null>`CASE WHEN octet_length(${navigation}) <=
          CASE WHEN event.navigation_json IS NULL THEN ${run.maxBytes} ELSE ${MAX_NAVIGATION_BYTES} END
          THEN ${navigation} ELSE NULL END`.as("navigation"),
      )
      .where("active.session_id", "=", sessionId);
    const supportsNative = readTranscriptStorageEncoding(projection.database.db) === "UTF-8";
    let found = false;
    for (const row of iterateSqliteQuerySync(projection.database.db, metadata)) {
      let navigationJson = row.navigation;
      if (navigationJson === null && supportsNative) {
        // Oversized bodies still have readable run metadata. Its shared native
        // owner rejects unsupported Unicode and caps projection before hydration.
        navigationJson =
          executeSqliteQueryTakeFirstSync(
            projection.database.db,
            db
              .selectFrom("transcript_events as event")
              .select(
                projectSupportedTranscriptPayloadNavigationSql(
                  transcriptEventJsonSql(projection.database.db, "event"),
                  MAX_NAVIGATION_BYTES,
                ).as("navigation"),
              )
              .where("event.session_id", "=", sessionId)
              .where("event.seq", "=", row.event_seq),
          )?.navigation ?? null;
      }
      if (navigationJson === null) {
        continue;
      }
      const event = asOptionalRecord(JSON.parse(navigationJson));
      let eventRunId =
        readSessionTranscriptRunId(event?.message) ?? readSessionTranscriptFailureRunId(event);
      if (!eventRunId && event?.customType === "run-failed-before-reply") {
        // Cached navigation omits failure details. Parse the exact bounded receipt
        // instead of applying SQLite's different duplicate-key/Unicode semantics.
        const raw = transcriptEventJsonSql(projection.database.db, "event");
        const receipt = executeSqliteQueryTakeFirstSync(
          projection.database.db,
          db
            .selectFrom("transcript_events as event")
            .select(
              /* kysely-allow-raw: Exceptional failure metadata must not hydrate an unbounded event. */
              sql<string | null>`CASE WHEN octet_length(${raw}) <= ${run.maxBytes}
              THEN ${raw} ELSE NULL END`.as("event"),
            )
            .where("event.session_id", "=", sessionId)
            .where("event.seq", "=", row.event_seq),
        );
        if (receipt?.event) {
          eventRunId = readSessionTranscriptFailureRunId(JSON.parse(receipt.event));
        }
      }
      if (eventRunId === run.id) {
        found = true;
        break;
      }
    }
    if (!found) {
      return undefined;
    }
  }
  return { sessionId, sessionKey: owner.session_key };
}
