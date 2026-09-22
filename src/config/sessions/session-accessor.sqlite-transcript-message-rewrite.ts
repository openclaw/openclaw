import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import {
  readSessionTranscriptRunId,
  resolveTerminalAssistantTranscriptRunId,
} from "../../sessions/transcript-events.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  findTranscriptEventInDatabase,
  readTranscriptIdentityByEventId,
} from "./session-accessor.sqlite-read.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  transcriptWriteScopeIsCurrent,
} from "./session-accessor.sqlite-scope.js";
import { readTranscriptGenerationInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { rewriteSqliteTranscriptEventRowsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import type { SessionTranscriptAccessScope } from "./session-accessor.types.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import type { SessionLifecycleRevisionExpectation } from "./session-transcript-turn-lifecycle.types.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import {
  assertOwnedTranscriptWriteCommit,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";

type TranscriptMessageAnchorRewriteResult<TMessage> = {
  generation: string;
  message: TMessage;
};

/** Rewrites one exact anchored message without rejecting unrelated later appends. */
export async function rewriteTranscriptMessageAtAnchor<TMessage>(
  anchor: TranscriptEntryAnchor,
  rewriteMessage: (message: unknown) => TMessage | undefined,
): Promise<TranscriptMessageAnchorRewriteResult<TMessage> | null> {
  const resolved = resolveSqliteTranscriptScope(anchor);
  return await runExclusiveSqliteSessionWrite(
    resolved,
    async () => {
      let result: TranscriptMessageAnchorRewriteResult<TMessage> | null = null;
      runOpenClawAgentWriteTransaction(
        (database) => {
          assertSessionTranscriptHot(database.db, resolved.sessionId);
          const row = executeSqliteQueryTakeFirstSync(
            database.db,
            getSessionKysely(database.db)
              .selectFrom("transcript_events")
              .select("event_json")
              .where("session_id", "=", resolved.sessionId)
              .where("seq", "=", anchor.rawSeq),
          );
          if (!row) {
            return;
          }
          const event = JSON.parse(row.event_json) as unknown;
          if (!isRecord(event) || event.type !== "message" || event.id !== anchor.entryId) {
            return;
          }
          const message = rewriteMessage(event.message);
          if (message === undefined) {
            return;
          }
          rewriteSqliteTranscriptEventRowsInTransaction(database, resolved, [
            {
              event: { ...event, message },
              expectedEventJson: row.event_json,
              seq: anchor.rawSeq,
            },
          ]);
          const generation = readTranscriptGenerationInTransaction(database, resolved.sessionId);
          if (generation) {
            result = { generation, message };
          }
        },
        toDatabaseOptions(resolved),
        { operationLabel: "session.transcript.message-rewrite" },
      );
      return result;
    },
    "session.transcript.message-rewrite",
  );
}

/** Updates the terminal assistant owned by one run, preserving unrelated later turns. */
export async function rewriteAssistantTranscriptMessageForRun(params: {
  scope: SessionTranscriptAccessScope;
  runId: string;
  expectedLifecycleRevision: SessionLifecycleRevisionExpectation;
  rewriteMessage: (message: Record<string, unknown>) => Record<string, unknown>;
}): Promise<{ messageId: string } | null> {
  const scope = withOwnedSessionTranscriptWriterFence({
    ...params.scope,
    expectedLifecycleRevision: params.expectedLifecycleRevision ?? undefined,
  });
  const resolved = resolveSqliteTranscriptScope(scope);
  const { restoreSessionColdTranscript } = await import("./session-cold-storage.js");
  await restoreSessionColdTranscript({ ...scope, sessionId: resolved.sessionId });
  return await runExclusiveSqliteSessionWrite(
    resolved,
    async () =>
      runOpenClawAgentWriteTransaction((database) => {
        assertSessionTranscriptHot(database.db, resolved.sessionId);
        assertOwnedTranscriptWriteCommit(scope);
        const current = readSessionEntryRow(database, resolved.sessionKey)?.entry;
        if (
          !transcriptWriteScopeIsCurrent(current, resolved.sessionId, scope) ||
          current?.lifecycleRevision !== (params.expectedLifecycleRevision ?? undefined)
        ) {
          throw new SessionTranscriptWriterClaimReboundError();
        }
        const found = findTranscriptEventInDatabase(database, resolved.sessionId, (event) => {
          if (!isRecord(event) || !isRecord(event.message)) {
            return false;
          }
          return (
            readSessionTranscriptRunId(event.message) === params.runId &&
            resolveTerminalAssistantTranscriptRunId(event.message, params.runId) !== undefined
          );
        });
        const event = found?.event;
        if (!isRecord(event) || typeof event.id !== "string" || !isRecord(event.message)) {
          return null;
        }
        const identity = readTranscriptIdentityByEventId(database, resolved.sessionId, event.id);
        if (!identity) {
          return null;
        }
        const message = params.rewriteMessage(event.message);
        const changed = !isDeepStrictEqual(message, event.message);
        if (changed) {
          rewriteSqliteTranscriptEventRowsInTransaction(database, resolved, [
            {
              event: { ...event, message },
              expectedEventJson: JSON.stringify(event),
              seq: identity.seq,
            },
          ]);
        }
        return { messageId: event.id };
      }, toDatabaseOptions(resolved)),
    "session.transcript.message-rewrite",
  );
}
