import { sql } from "kysely";
import {
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
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

// These derived facts omit transcript bodies and remain inside the admitted snapshot.
const inputMessageJson =
  /* kysely-allow-raw: Project only input provenance and exact run correlation without hydrating message bodies. */
  sql<string>`json_object('role', json_extract(event.event_json, '$.message.role'),
    'idempotencyKey', json_extract(event.event_json, '$.message.idempotencyKey'),
    'provenance', json_extract(event.event_json, '$.message.provenance'),
    '__openclaw', json_object(
      'runId', json_extract(event.event_json, '$.message.__openclaw.runId'),
      'steerTargetRunId', json_extract(event.event_json, '$.message.__openclaw.steerTargetRunId')))`;

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
  const keptPositions =
    /* kysely-allow-raw: Bind the exact retained display positions without SQLite's variable limit. */
    sql<number>`(SELECT value FROM json_each(${JSON.stringify(visible.kept)}))`;
  const userInputs = db
    .selectFrom("session_transcript_active_events as active")
    .innerJoin("transcript_events as event", (join) =>
      join
        .onRef("event.session_id", "=", "active.session_id")
        .onRef("event.seq", "=", "active.event_seq"),
    )
    .select(["active.message_position", inputMessageJson.as("message_json")])
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
    .where(
      /* kysely-allow-raw: Validate the persisted role without materializing input bodies. */
      sql<string>`json_extract(event.event_json, '$.message.role')`,
      "=",
      "user",
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
          /* kysely-allow-raw: A steering admission cannot identify the input that originated its receiving run. */
          sql<
            string | null
          >`json_extract(event.event_json, '$.message.__openclaw.steerTargetRunId')`,
          "is",
          null,
        )
        .limit(1),
    );
    if (!anchor || !params.isHiddenInput(JSON.parse(anchor.message_json))) {
      return { hidden: false };
    }
    readAfter = anchor.message_position;
  }
  // A reply's visibility cannot depend on later transcript entries. Resume only
  // beyond already inspected inputs when another output from this run is read.
  const laterInputs = userInputs
    .where("active.message_position", ">", readAfter)
    .where("active.message_position", "<=", scannedThroughMessagePosition)
    .where((eb) =>
      eb.or([
        eb(
          /* kysely-allow-raw: Match only steering committed to this exact run. */
          sql<string>`json_extract(event.event_json, '$.message.__openclaw.steerTargetRunId')`,
          "=",
          params.runId,
        ),
        eb(
          /* kysely-allow-raw: Retained user records can carry the receiving run explicitly. */
          sql<string>`json_extract(event.event_json, '$.message.__openclaw.runId')`,
          "=",
          params.runId,
        ),
      ]),
    )
    .orderBy("active.message_position", "asc");
  for (const row of iterateSqliteQuerySync(projection.database.db, laterInputs)) {
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
