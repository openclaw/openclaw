import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type {
  SessionActivitySummaryBatchInput,
  SessionActivitySummaryBatchResult,
} from "../config/sessions/activity-summary-source.types.js";
import {
  SessionTranscriptProjectionUnavailableError,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import {
  prepareSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { resolveSessionTranscriptReadFence } from "../config/sessions/session-transcript-read-fence.js";
import { startSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import {
  extractAssistantPhaseText,
  extractAssistantTextForPhase,
} from "../shared/chat-message-content.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { readActivitySummaryBatchFromReplica } from "./session-activity-summary-replica.js";

function withActivitySummaryNotes(source: SessionActivitySummaryBatchResult) {
  if (!source) {
    return undefined;
  }
  const notes = source.page.events.flatMap(({ event }) => {
    const message = isRecord(event) ? event.message : undefined;
    if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant")) {
      return [];
    }
    const text =
      message.role === "assistant"
        ? (extractAssistantPhaseText(message) ??
          extractAssistantTextForPhase(message, { phase: "commentary" }))
        : extractTextFromChatContent(message.content);
    const cleaned = (text ?? "").replace(/\s+/gu, " ").trim();
    if (!cleaned) {
      return [];
    }
    const excerpt =
      cleaned.length <= 800
        ? cleaned
        : `${sliceUtf16Safe(cleaned, 0, 395)} … ${sliceUtf16Safe(cleaned, -400)}`;
    return [`${message.role}: ${excerpt}`];
  });
  return { ...source, notes };
}

export async function readActivitySummarySource(
  params: SessionActivitySummaryBatchInput & {
    assertCurrent: () => void;
  },
) {
  const resolved = await prepareSqliteTranscriptReadScope(params.scope);
  params.assertCurrent();
  const options = toDatabaseOptions(resolved);
  const scope = {
    ...params.scope,
    agentId: resolved.agentId,
    storePath: resolveOpenClawAgentSqlitePath(options),
  };
  const admission = resolveSessionTranscriptReadFence(resolved);
  const resident =
    !admission && readActivitySummaryBatchFromReplica({ scope, previous: params.previous });
  if (resident) {
    return withActivitySummaryNotes(resident);
  }
  const { readRestoredSessionTranscript } =
    await import("../config/sessions/session-cold-storage-read.js");
  const { withSessionHistoryWorkerDatabase } =
    await import("../config/sessions/session-transcript-worker-runtime.js");
  return withSessionHistoryWorkerDatabase(options, async (owner) => {
    const read = async () => {
      params.assertCurrent();
      const source = await owner.readActivitySummarySource({
        scope,
        previous: params.previous,
        admission,
      });
      params.assertCurrent();
      return withActivitySummaryNotes(source);
    };
    for (let retry = false; ; retry = true) {
      try {
        return await readRestoredSessionTranscript(scope, read, {
          assertCurrent: params.assertCurrent,
        });
      } catch (error) {
        if (retry || !(error instanceof SessionTranscriptProjectionUnavailableError)) {
          throw error;
        }
        params.assertCurrent();
        startSessionTranscriptIndexReconcile({
          ...options,
          preferredSessionId: resolved.sessionId,
        });
        await waitForSessionTranscriptProjection(scope);
      }
    }
  });
}
