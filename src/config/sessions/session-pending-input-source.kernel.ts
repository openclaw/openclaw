import { MAX_PAYLOAD_BYTES } from "../../gateway/server-constants.js";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { parseSessionPendingInputMessage } from "./session-accessor.sqlite-pending-inputs.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { readTranscriptMessageByScopedIdempotencyKey } from "./session-accessor.sqlite-transcript-store.js";
import type {
  PendingInputSourceRead,
  PendingInputSourceSnapshot,
} from "./session-pending-input-operations.types.js";
import { sessionTranscriptIndexNeedsReconcile } from "./session-transcript-index.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";

/** Read comparison evidence only; recovered custody is claimed by the current host owner. */
export function readPendingInputSourceInDatabase(
  database: Pick<OpenClawAgentDatabase, "agentId" | "path" | "db">,
  input: PendingInputSourceRead,
): PendingInputSourceSnapshot {
  return runSqliteDeferredTransactionSync(database.db, () => {
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
      .where("session_key", "=", input.sessionKey)
      .where("session_id", "=", input.sessionId)
      .where("idempotency_key", "=", input.idempotencyKey);
    const pending = getAdmittedSqliteSchemaFacts(database.db)?.tables.has("session_pending_inputs")
      ? executeSqliteQueryTakeFirstSync(
          database.db,
          pendingQuery.select((eb) => eb.fn<number>("octet_length", ["message_json"]).as("bytes")),
        )
      : undefined;
    if (pending) {
      if (pending.bytes > MAX_PAYLOAD_BYTES) {
        throw new Error("Submitted input exceeds the Gateway payload limit");
      }
      snapshot.pending = executeSqliteQueryTakeFirstSync(database.db, pendingQuery.selectAll());
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
          .select(transcriptEventReadBytesSql("event").as("bytes"))
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
      }
    }
    return snapshot;
  });
}
