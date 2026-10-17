import { sql } from "kysely";
import {
  jsonArrayElements,
  jsonObjectValue,
  jsonPathValue,
  jsonSetPath,
} from "../../infra/database-engine/json-values.js";
import {
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import {
  resolveHistoryMessageSequence,
  resolveVisibleHistoryProjection,
  resolveVisibleHistoryRange,
} from "./session-accessor.sqlite-history-projection.js";
import {
  getActiveTranscriptKysely,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import { resolveVisibleMessagePositions } from "./session-accessor.sqlite-reset-window.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { transcriptEventNavigationSql, transcriptEventRunIdSql } from "./transcript-payload.js";
import { assertTranscriptNavigationValid } from "./transcript-predicate-fields.js";

// These derived facts omit transcript bodies and remain inside the admitted snapshot.
const inputMessageJson = (database: EngineConnection) => {
  const navigation = transcriptEventNavigationSql(database, "event");
  return jsonSetPath(
    database,
    jsonObjectValue(database, {
      role: jsonPathValue(database, navigation, sql.lit("$.message.role")),
      idempotencyKey: jsonPathValue(database, navigation, sql.lit("$.message.idempotencyKey")),
      __openclaw: jsonObjectValue(database, {
        runId: transcriptEventRunIdSql(database, "event"),
        steerTargetRunId: jsonPathValue(
          database,
          navigation,
          sql.lit("$.message.__openclaw.steerTargetRunId"),
        ),
      }),
    }),
    sql.lit("$.provenance"),
    jsonPathValue(database, navigation, sql.lit("$.message.provenance"), "json"),
    true,
  );
};

type RunInputVisibility =
  | { hidden: false }
  | {
      hidden: true;
      scannedThroughMessageSeq: number;
      scannedThroughMessagePosition: number;
      firstVisibleMessageSeq?: number;
    };

/** Resolve a run's hidden input and the first visible steer on its active transcript branch. */
export function readSessionTranscriptRunInputVisibilityFromProjection(
  projection: CurrentTranscriptProjection,
  params: {
    idempotencyKey: string;
    runId: string;
    messageSeq: number;
    previous?: Extract<RunInputVisibility, { hidden: true }>;
    isHiddenInput: (message: unknown) => boolean;
  },
): RunInputVisibility {
  const db = getActiveTranscriptKysely(projection.database);
  // Validate custody without applying execution-only bounds to requested display history.
  resolveSqliteSessionTranscriptReadFence({
    database: projection.database,
    ...projection.resolved,
  });
  const visible = resolveVisibleMessagePositions(projection);
  const keptPositions =
    /* kysely-allow-raw: Bind the exact retained display positions without SQLite's variable limit. */
    sql<number>`(SELECT CAST(value AS BIGINT) FROM ${jsonArrayElements(projection.database.db, sql.val(JSON.stringify(visible.kept)))})`;
  const userInputs = db
    .selectFrom("session_transcript_active_events as active")
    .innerJoin("transcript_events as event", (join) =>
      join
        .onRef("event.session_id", "=", "active.session_id")
        .onRef("event.seq", "=", "active.event_seq"),
    )
    .select([
      "active.message_position",
      "event.navigation_valid",
      inputMessageJson(projection.database.db).as("message_json"),
    ])
    .where("active.session_id", "=", projection.resolved.sessionId)
    .where("active.message_position", "<", projection.state.activeMessageCount)
    .where((eb) =>
      visible.kept.length > 0
        ? eb.or([
            eb("active.message_position", ">=", visible.postStart),
            eb("active.message_position", "in", keptPositions),
          ])
        : eb("active.message_position", ">=", visible.postStart),
    )
    .where((eb) =>
      eb.or([eb("event.message_role", "=", "user"), eb("event.navigation_valid", "=", 0)]),
    )
    .$narrowType<{ message_position: number }>();
  let readAfter = params.previous?.scannedThroughMessagePosition;
  if (readAfter === undefined) {
    const anchor = executeSqliteQueryTakeFirstSync(
      projection.database.db,
      userInputs
        .innerJoin("transcript_event_identities as identity", (join) =>
          join
            .onRef("identity.session_id", "=", "active.session_id")
            .onRef("identity.seq", "=", "active.event_seq"),
        )
        .where("identity.message_idempotency_key", "=", params.idempotencyKey)
        .where(
          jsonPathValue(
            projection.database.db,
            transcriptEventNavigationSql(projection.database.db, "event"),
            sql.lit("$.message.__openclaw.steerTargetRunId"),
          ),
          "is",
          null,
        )
        .limit(1),
    );
    assertTranscriptNavigationValid(anchor?.navigation_valid);
    if (!anchor || !params.isHiddenInput(JSON.parse(anchor.message_json))) {
      return { hidden: false };
    }
    readAfter = anchor.message_position;
  }
  const history = resolveVisibleHistoryProjection(projection);
  const { messageEnd } = resolveVisibleHistoryRange(
    history,
    params.messageSeq - 1,
    params.messageSeq,
  );
  const scannedThroughMessagePosition =
    messageEnd <= visible.kept.length
      ? (visible.kept[messageEnd - 1] ?? -1)
      : visible.postStart + messageEnd - visible.kept.length - 1;
  const hidden = {
    hidden: true as const,
    scannedThroughMessageSeq: params.messageSeq,
    scannedThroughMessagePosition,
  };
  // A reply's visibility cannot depend on later transcript entries. Resume only
  // beyond already inspected inputs when another output from this run is read.
  const laterInputs = userInputs
    .where("active.message_position", ">", readAfter)
    .where("active.message_position", "<=", scannedThroughMessagePosition)
    .where((eb) =>
      eb.or([
        eb(
          jsonPathValue(
            projection.database.db,
            transcriptEventNavigationSql(projection.database.db, "event"),
            sql.lit("$.message.__openclaw.steerTargetRunId"),
          ),
          "=",
          params.runId,
        ),
        eb(transcriptEventRunIdSql(projection.database.db, "event"), "=", params.runId),
      ]),
    )
    .orderBy("active.message_position", "asc");
  for (const row of iterateSqliteQuerySync(projection.database.db, laterInputs)) {
    assertTranscriptNavigationValid(row.navigation_valid);
    if (!params.isHiddenInput(JSON.parse(row.message_json))) {
      const firstVisibleMessageSeq = resolveHistoryMessageSequence(
        visible,
        history,
        row.message_position,
      );
      return firstVisibleMessageSeq === undefined
        ? { hidden: false }
        : { ...hidden, firstVisibleMessageSeq };
    }
  }
  return hidden;
}
