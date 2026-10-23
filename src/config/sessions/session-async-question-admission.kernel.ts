import { jsonPathValue } from "../../infra/database-engine/json-values.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import {
  ASYNC_QUESTION_ANSWERED,
  assertAsyncQuestionSource,
  readAsyncQuestionAnswer,
} from "../../shared/async-question-answer.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { hasSessionPendingInputsSchema } from "../../state/openclaw-agent-pending-inputs-schema.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { readTranscriptMessageByEventId } from "./session-accessor.sqlite-transcript-identity.js";
import { isTranscriptEntryOnActivePathInTransaction } from "./session-accessor.sqlite-transcript-parent.js";
import { transcriptEventJsonSql, transcriptPredicateSql } from "./transcript-payload.js";

/** Runs in the existing acceptInput transaction, before either queued or transcript custody. */
export function assertSessionAsyncQuestionAdmission(
  database: OpenClawAgentDatabase,
  scope: { sessionKey: string; sessionId: string },
  message: unknown,
): void {
  const answer = readAsyncQuestionAnswer(message);
  if (!answer) {
    return;
  }
  const { sessionId } = scope;
  const { sourceMessageId, itemId, idempotencyKey } = answer;
  const source = isTranscriptEntryOnActivePathInTransaction(database, sessionId, sourceMessageId)
    ? readTranscriptMessageByEventId(
        database,
        { ...scope, agentId: database.agentId, path: database.path },
        sourceMessageId,
      )
    : undefined;
  assertAsyncQuestionSource(source?.message, itemId);
  const db = getSessionKysely(database.db);
  const pending =
    hasSessionPendingInputsSchema(database.db) &&
    executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_pending_inputs")
        .select("input_id")
        .where("session_key", "=", scope.sessionKey)
        .where("session_id", "=", sessionId)
        .where("state", "!=", "cancelled")
        .where("consumed_event_id", "is", null)
        .where("idempotency_key", "!=", idempotencyKey)
        .where((eb) =>
          eb(
            jsonPathValue(database.db, eb.ref("message_json"), eb.val("$.__openclaw.replyToId")),
            "=",
            sourceMessageId,
          ),
        ),
    );
  if (pending) {
    throw new Error(ASYNC_QUESTION_ANSWERED);
  }
  // Legacy answers already have replyToId. Keep those accepted facts authoritative
  // without migrating data or treating an ordinary later correction as another claim.
  const candidates = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events as event")
      .innerJoin("transcript_event_identities as identity", (join) =>
        join
          .onRef("identity.session_id", "=", "event.session_id")
          .onRef("identity.seq", "=", "event.seq"),
      )
      .select(["identity.event_id", "identity.message_idempotency_key"])
      .where("event.session_id", "=", sessionId)
      .where((eb) => eb(transcriptPredicateSql(database.db, "message_role", "event"), "=", "user"))
      .where((eb) =>
        eb(
          jsonPathValue(
            database.db,
            transcriptEventJsonSql(database.db, "event"),
            eb.val("$.message.__openclaw.replyToId"),
          ),
          "=",
          sourceMessageId,
        ),
      ),
  ).rows;
  if (
    candidates.some(
      (candidate) =>
        candidate.message_idempotency_key !== idempotencyKey &&
        isTranscriptEntryOnActivePathInTransaction(database, sessionId, candidate.event_id),
    )
  ) {
    throw new Error(ASYNC_QUESTION_ANSWERED);
  }
}
