import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import {
  jsonArrayElements,
  jsonNativeFieldsValid,
  jsonObjectValue,
  jsonPathValue,
  jsonSetPath,
} from "../../infra/database-engine/json-values.js";
import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import {
  resolveHistoryMessageSequence,
  resolveVisibleHistoryProjection,
  resolveVisibleHistoryRange,
} from "./session-accessor.sqlite-history-projection.js";
import {
  selectActiveTranscriptEventRows,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import { resolveVisibleMessagePositions } from "./session-accessor.sqlite-reset-window.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import {
  transcriptEventNavigationSql,
  transcriptEventRunIdSql,
  transcriptPredicateSql,
} from "./transcript-payload.js";
import { assertTranscriptNavigationValid } from "./transcript-predicate-fields.js";

// These derived facts omit transcript bodies and remain inside the admitted snapshot.
// Rows native fields cannot decode return the original entry for readInputMessage.
const inputMessageJson = (database: EngineConnection) => {
  const navigation = transcriptEventNavigationSql(database, "event");
  const facts = jsonSetPath(
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
  return /* kysely-allow-raw: CASE fences native decoding of escapes JSONB rejects. */ sql<string>`CASE WHEN ${jsonNativeFieldsValid(database, navigation)} THEN ${facts} ELSE ${navigation} END`;
};

function readInputMessage(row: { native: unknown; message_json: string }) {
  const parsed: unknown = JSON.parse(row.message_json);
  return asOptionalRecord(row.native ? parsed : asOptionalRecord(parsed)?.message);
}

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
  // Validate custody without applying execution-only bounds to requested display history.
  resolveSqliteSessionTranscriptReadFence({
    database: projection.database,
    ...projection.resolved,
  });
  const visible = resolveVisibleMessagePositions(projection);
  const db = projection.database.db;
  const navigation = transcriptEventNavigationSql(db, "event");
  const native = jsonNativeFieldsValid(db, navigation);
  const steerTargetRunId =
    /* kysely-allow-raw: CASE fences native decoding; readInputMessage rechecks other rows. */
    sql<
      string | null
    >`CASE WHEN ${native} THEN ${jsonPathValue(db, navigation, sql.lit("$.message.__openclaw.steerTargetRunId"))} END`;
  const keptPositions =
    /* kysely-allow-raw: Bind the exact retained display positions without SQLite's variable limit. */
    sql<number>`(SELECT CAST(value AS BIGINT) FROM ${jsonArrayElements(db, sql.val(JSON.stringify(visible.kept)))})`;
  const userInputs = selectActiveTranscriptEventRows(projection.database)
    .select([
      "active.message_position",
      transcriptPredicateSql(projection.database.db, "navigation_valid", "event").as(
        "navigation_valid",
      ),
      inputMessageJson(projection.database.db).as("message_json"),
      native.as("native"),
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
      eb.or([
        eb(transcriptPredicateSql(projection.database.db, "message_role", "event"), "=", "user"),
        eb(transcriptPredicateSql(projection.database.db, "navigation_valid", "event"), "=", 0),
      ]),
    )
    .$narrowType<{ message_position: number }>();
  let readAfter = params.previous?.scannedThroughMessagePosition;
  if (readAfter === undefined) {
    let anchor:
      | { message_position: number; message: Record<string, unknown> | undefined }
      | undefined;
    for (const row of iterateSqliteQuerySync(
      db,
      userInputs
        .innerJoin("transcript_event_identities as identity", (join) =>
          join
            .onRef("identity.session_id", "=", "active.session_id")
            .onRef("identity.seq", "=", "active.event_seq"),
        )
        .where("identity.message_idempotency_key", "=", params.idempotencyKey)
        .where(steerTargetRunId, "is", null),
    )) {
      assertTranscriptNavigationValid(row.navigation_valid);
      const message = readInputMessage(row);
      if (asOptionalRecord(message?.["__openclaw"])?.steerTargetRunId == null) {
        anchor = { message_position: row.message_position, message };
        break;
      }
    }
    if (!anchor || !params.isHiddenInput(anchor.message)) {
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
        eb.not(native),
        eb(steerTargetRunId, "=", params.runId),
        eb(transcriptEventRunIdSql(db, "event"), "=", params.runId),
      ]),
    )
    .orderBy("active.message_position", "asc");
  for (const row of iterateSqliteQuerySync(db, laterInputs)) {
    assertTranscriptNavigationValid(row.navigation_valid);
    const message = readInputMessage(row);
    const internal = asOptionalRecord(message?.["__openclaw"]);
    if (
      !row.native &&
      internal?.steerTargetRunId !== params.runId &&
      internal?.runId !== params.runId
    ) {
      continue;
    }
    if (!params.isHiddenInput(message)) {
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
