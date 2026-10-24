import { MAX_PAYLOAD_BYTES } from "../../gateway/payload-limits.js";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { hasSessionPendingInputsSchema } from "../../state/openclaw-agent-pending-inputs-schema.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { readTranscriptMessageByScopedIdempotencyKey } from "./session-accessor.sqlite-transcript-identity.js";
import type {
  PendingInputSourceRead,
  PendingInputSourceSnapshot,
} from "./session-pending-input-operations.types.js";
import { parseSessionPendingInputMessage } from "./session-pending-input-value.js";
import { sessionTranscriptIndexNeedsReconcile } from "./session-transcript-index.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";

/** Worker-only comparison evidence; recovered custody is claimed by the current host owner. */
export function readPendingInputSourceInDatabase(
  database: Pick<OpenClawAgentDatabase, "agentId" | "path" | "db">,
  input: PendingInputSourceRead,
): PendingInputSourceSnapshot {
  return runSqliteReadSnapshotSync(database.db, () => {
    const db = getSessionKysely(database.db);
    const session = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_nodes")
        .innerJoin(
          "session_windows",
          "session_windows.session_id",
          "session_nodes.current_session_id",
        )
        .select("current_session_id")
        .where("session_nodes.session_key", "=", input.sessionKey)
        .where("session_windows.session_key", "=", input.sessionKey),
    );
    const snapshot: PendingInputSourceSnapshot = {
      kind: "source",
      current: session?.current_session_id === input.sessionId,
    };
    if (!snapshot.current) {
      return snapshot;
    }
    const pendingQuery = db
      .selectFrom("session_pending_inputs")
      .where("session_pending_inputs.session_key", "=", input.sessionKey)
      .where("session_pending_inputs.session_id", "=", input.sessionId)
      .where("session_pending_inputs.idempotency_key", "=", input.idempotencyKey);
    const pending = hasSessionPendingInputsSchema(database.db)
      ? executeSqliteQueryTakeFirstSync(
          database.db,
          pendingQuery.select((eb) => eb.fn<number>("octet_length", ["message_json"]).as("bytes")),
        )
      : undefined;
    if (pending) {
      if (pending.bytes > MAX_PAYLOAD_BYTES) {
        throw new Error("Submitted input exceeds the Gateway payload limit");
      }
      const retained = executeSqliteQueryTakeFirstSync(
        database.db,
        pendingQuery
          .leftJoin("transcript_event_identities as consumed", (join) =>
            join
              .onRef("consumed.session_id", "=", "session_pending_inputs.session_id")
              .onRef("consumed.event_id", "=", "session_pending_inputs.consumed_event_id"),
          )
          .leftJoin("session_transcript_active_events as active", (join) =>
            join
              .onRef("active.session_id", "=", "consumed.session_id")
              .onRef("active.event_seq", "=", "consumed.seq"),
          )
          .selectAll("session_pending_inputs")
          .select("active.message_position"),
      );
      if (retained) {
        const { message_position, ...row } = retained;
        snapshot.pending = row;
        if (
          message_position !== null &&
          !sessionTranscriptIndexNeedsReconcile(database.db, input.sessionId)
        ) {
          snapshot.committedMessageSeq = message_position + 1;
        }
      }
    } else if (!input.pendingOnly) {
      if (sessionTranscriptIndexNeedsReconcile(database.db, input.sessionId)) {
        throw new SessionTranscriptProjectionUnavailableError(input.sessionId);
      }
      const transcript = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("transcript_event_identities as identity")
          .innerJoin("transcript_events as event", (join) =>
            join
              .onRef("event.session_id", "=", "identity.session_id")
              .onRef("event.seq", "=", "identity.seq"),
          )
          .leftJoin("session_transcript_active_events as active", (join) =>
            join
              .onRef("active.session_id", "=", "identity.session_id")
              .onRef("active.event_seq", "=", "identity.seq"),
          )
          .select(transcriptEventReadBytesSql("event").as("bytes"))
          .select("active.message_position")
          .where("identity.session_id", "=", input.sessionId)
          .where("identity.message_idempotency_key", "=", input.idempotencyKey)
          .orderBy("identity.seq", "desc")
          .limit(1),
      );
      if (transcript && transcript.bytes > MAX_PAYLOAD_BYTES) {
        throw new Error("Submitted input exceeds the Gateway payload limit");
      }
      if (transcript) {
        const committed = readTranscriptMessageByScopedIdempotencyKey(
          database,
          { ...input, agentId: database.agentId, path: database.path },
          input.idempotencyKey,
          "scan",
        );
        snapshot.committed = committed
          ? parseSessionPendingInputMessage(JSON.stringify(committed.message))
          : undefined;
        if (snapshot.committed && transcript.message_position !== null) {
          snapshot.committedMessageSeq = transcript.message_position + 1;
        }
      }
    }
    return snapshot;
  });
}
