import { readSessionTranscriptBoundedMessageTailPageFromProjection } from "../config/sessions/session-accessor.sqlite-active-events-read.js";
import { withCurrentProjectionSnapshot } from "../config/sessions/session-accessor.sqlite-active-projection.js";
import { preserveSessionEntryCacheAcrossWrite } from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import { getSessionKysely } from "../config/sessions/session-accessor.sqlite-scope.js";
import { SessionTranscriptColdError } from "../config/sessions/session-transcript-cold-error.js";
import {
  isSessionTranscriptProjectionUnavailableError,
  SessionTranscriptStorageUnavailableError,
} from "../config/sessions/session-transcript-projection-error.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { readSessionTranscriptTerminalModel } from "../sessions/transcript-terminal-model.js";
import type { OpenClawAgentDatabase } from "../state/openclaw-agent-db-contract.js";
import { projectSessionDisplayMessage } from "./session-display-projection.js";
import type { SessionRowTranscriptReadParams } from "./session-row-transcript-backfill.types.js";
import {
  projectSessionRowAssistantMessage,
  SESSION_ROW_TRANSCRIPT_PREVIEW_MAX_BYTES,
  SESSION_ROW_TRANSCRIPT_TERMINAL_MAX_BYTES,
  type SessionRowTranscriptProjection,
} from "./session-row-transcript-preview.js";
import { sqliteMessageEventWithSeq } from "./session-transcript-entry-message.js";

/** Read and persist bounded derived facts in the existing writer's transaction. */
export function backfillSessionRowTranscriptFieldsInDatabase(
  database: OpenClawAgentDatabase,
  params: SessionRowTranscriptReadParams,
): SessionRowTranscriptProjection | undefined {
  const transcriptScope = { ...params, agentId: params.storeAgentId ?? params.agentId };
  try {
    return withCurrentProjectionSnapshot(
      transcriptScope,
      (projection) => {
        const tail = readSessionTranscriptBoundedMessageTailPageFromProjection(projection, {
          maxMessages: 20,
          maxBytes: SESSION_ROW_TRANSCRIPT_PREVIEW_MAX_BYTES,
          offset: 0,
        });
        const terminalEvent = tail.newestContiguousEventCount
          ? tail.events.at(-1)?.event
          : tail.totalMessages
            ? readSessionTranscriptBoundedMessageTailPageFromProjection(projection, {
                maxMessages: 1,
                maxBytes: SESSION_ROW_TRANSCRIPT_TERMINAL_MAX_BYTES,
                offset: 0,
              }).events[0]?.event
            : undefined;
        const fields: SessionRowTranscriptProjection = {
          lastMessagePreview: null,
          lastAssistantMessage: null,
          terminalModel: readSessionTranscriptTerminalModel(terminalEvent),
          indexedSeq: projection.state.indexedSeq < 0 ? null : projection.state.indexedSeq,
        };
        // Older text cannot stand in for an oversized message skipped at the newest edge.
        const events = tail.newestContiguousEventCount
          ? tail.events.slice(-tail.newestContiguousEventCount)
          : [];
        for (const event of events.toReversed()) {
          const projected = projectSessionDisplayMessage(sqliteMessageEventWithSeq(event), {
            flattenMarkdown: true,
          });
          if (projected) {
            fields.lastMessagePreview ??= Buffer.from(projected.text, "utf16le").toString(
              "utf16le",
            );
            if (projected.role === "assistant") {
              fields.lastAssistantMessage = projectSessionRowAssistantMessage(
                event.event,
                projected.text,
              );
              break;
            }
          }
        }
        preserveSessionEntryCacheAcrossWrite(database, () => {
          executeSqliteQuerySync(
            database.db,
            getSessionKysely(database.db)
              .updateTable("session_windows")
              .set({
                row_transcript_json: JSON.stringify(fields),
                row_transcript_updated_at: projection.version.updatedAt,
              })
              .where("session_id", "=", params.sessionId),
          );
        });
        return fields;
      },
      { transaction: database },
    );
  } catch (error) {
    if (
      isSessionTranscriptProjectionUnavailableError(error) ||
      error instanceof SessionTranscriptStorageUnavailableError ||
      error instanceof SessionTranscriptColdError
    ) {
      return undefined;
    }
    throw error;
  }
}
