import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptWriteScope,
  TranscriptMessageAppendResult,
} from "./session-accessor.sqlite-contract.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { readHotSessionTranscriptSnapshot } from "./session-cold-storage-read.js";

// Append results are public SDK contracts. Keep commit-only cursor metadata
// attached to their object lifetime without changing the returned message shape.
const committedTranscriptMessageSequences = new WeakMap<object, number>();
const TRANSCRIPT_CURSOR_BATCH_SIZE = 64;

/** Reads the visible-message sequence captured from the final active branch. */
export function readCommittedTranscriptMessageSequence(
  message: TranscriptMessageAppendResult<unknown>,
): number | undefined {
  return committedTranscriptMessageSequences.get(message);
}

/** Captures atomic turn cursors from the final projection before SQLite commits. */
export function rememberCommittedTranscriptMessageSequencesInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
  messages: readonly TranscriptMessageAppendResult<unknown>[],
): void {
  const appendedMessages = messages.filter((message) => message.appended);
  for (const message of appendedMessages) {
    committedTranscriptMessageSequences.delete(message);
  }
  if (appendedMessages.length === 0) {
    return;
  }
  const db = getNodeSqliteKysely<
    Pick<
      OpenClawAgentKyselyDatabase,
      | "session_transcript_active_events"
      | "session_transcript_index_state"
      | "transcript_event_identities"
    >
  >(database.db);
  const projection = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_transcript_index_state")
      .select("needs_rebuild")
      .where("session_id", "=", sessionId),
  );
  if (projection?.needs_rebuild !== 0) {
    return;
  }
  for (let offset = 0; offset < appendedMessages.length; offset += TRANSCRIPT_CURSOR_BATCH_SIZE) {
    const batch = appendedMessages.slice(offset, offset + TRANSCRIPT_CURSOR_BATCH_SIZE);
    const rows = readHotSessionTranscriptSnapshot(
      database,
      sessionId,
      "identity",
      () =>
        executeSqliteQuerySync(
          database.db,
          db
            .selectFrom("transcript_event_identities as identity")
            .innerJoin("session_transcript_active_events as active", (join) =>
              join
                .onRef("active.session_id", "=", "identity.session_id")
                .onRef("active.event_seq", "=", "identity.seq"),
            )
            .select(["identity.event_id", "active.message_position"])
            .where("identity.session_id", "=", sessionId)
            .where(
              "identity.event_id",
              "in",
              batch.map((message) => message.messageId),
            )
            .where("active.message_position", "is not", null),
        ).rows,
    );
    const positions = new Map(rows.map((row) => [row.event_id, row.message_position]));
    for (const message of batch) {
      const position = positions.get(message.messageId);
      if (position !== null && position !== undefined) {
        // Raw event seq includes controls. Client cursors follow the final
        // active-branch message position so abandoned rows cannot leak.
        committedTranscriptMessageSequences.set(message, position + 1);
      }
    }
  }
}

/** Resolves final cursors while an ordinary turn still owns its writer transaction. */
export function rememberCommittedTranscriptMessageSequences(
  scope: SessionTranscriptWriteScope,
  messages: readonly TranscriptMessageAppendResult<unknown>[],
): void {
  if (messages.length === 0 || !scope.agentId || !scope.sessionId || !scope.sessionKey) {
    return;
  }
  const resolved = resolveSqliteTranscriptScope({
    agentId: scope.agentId,
    ...(scope.env ? { env: scope.env } : {}),
    sessionId: scope.sessionId,
    sessionKey: scope.sessionKey,
    ...(scope.storePath ? { storePath: scope.storePath } : {}),
  });
  rememberCommittedTranscriptMessageSequencesInTransaction(
    openOpenClawAgentDatabase(toDatabaseOptions(resolved)),
    resolved.sessionId,
    messages,
  );
}
