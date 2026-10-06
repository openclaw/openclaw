import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type {
  SessionActivitySummaryBatchInput,
  SessionActivitySummaryBatchResult,
} from "../config/sessions/activity-summary-source.types.js";
import { ACTIVITY_SUMMARY_FORMAT_REVISION } from "../config/sessions/activity-summary.js";
import {
  readSessionTranscriptActivePathEntryRelation,
  readSessionTranscriptBoundedMessageTailPage,
  readSessionTranscriptWatermark,
  SessionTranscriptProjectionUnavailableError,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import {
  prepareSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { resolveSessionTranscriptReadFence } from "../config/sessions/session-transcript-read-fence.js";
import { startSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import {
  extractAssistantPhaseText,
  extractAssistantTextForPhase,
} from "../shared/chat-message-content.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";

/** Runs in the existing transcript worker; only byte-bounded bodies leave it. */
export function readActivitySummaryBatch(
  params: SessionActivitySummaryBatchInput,
): SessionActivitySummaryBatchResult {
  const snapshot = readSessionTranscriptBoundedMessageTailPage(params.scope, {
    maxBytes: 0,
    maxMessages: 0,
    offset: 0,
    readOnly: true,
  });
  let previous = params.previous;
  if (
    previous &&
    (previous.generation !== (snapshot.snapshot.generation ?? null) ||
      previous.coveredMessages > snapshot.totalMessages ||
      (previous.leafEntryId &&
        !["exact", "ancestor"].includes(
          readSessionTranscriptActivePathEntryRelation(params.scope, previous.leafEntryId, {
            readOnly: true,
          }),
        )))
  ) {
    previous = undefined;
  }
  const watermark = readSessionTranscriptWatermark(params.scope);
  const covered = previous?.coveredMessages ?? 0;
  let batchSize = Math.min(64, snapshot.totalMessages - covered);
  const readPage = (maxMessages: number, includeEarlier = false) =>
    readSessionTranscriptBoundedMessageTailPage(params.scope, {
      maxBytes: 128 * 1024,
      maxMessages,
      offset: snapshot.totalMessages - covered - maxMessages,
      readOnly: true,
      oversizedMessageCheck: {
        roles: ["user", "assistant"],
        includeEarlier,
      },
    });
  const earlierOmission =
    previous?.omittedContent &&
    (previous.formatRevision === ACTIVITY_SUMMARY_FORMAT_REVISION ||
      readPage(0, true).hasOversizedMessages);
  let page = readPage(batchSize);
  while (batchSize > 1 && page.events.length < page.scannedMessages) {
    batchSize = Math.max(1, Math.floor(batchSize / 2));
    page = readPage(batchSize);
  }
  if (
    page.totalMessages !== snapshot.totalMessages ||
    page.snapshot.generation !== snapshot.snapshot.generation ||
    page.snapshot.indexedSeq !== snapshot.snapshot.indexedSeq
  ) {
    return undefined;
  }
  // Shrinking leaves only individually oversized omissions; recheck legacy flags by role.
  return {
    previous,
    snapshot,
    watermark,
    covered,
    page,
    omitted: earlierOmission === true || page.hasOversizedMessages === true,
  };
}

export async function readActivitySummarySource(
  params: SessionActivitySummaryBatchInput & {
    assertCurrent: () => void;
  },
) {
  const { readRestoredSessionTranscript } =
    await import("../config/sessions/session-cold-storage-read.js");
  const { withSessionHistoryWorkerDatabase } =
    await import("../config/sessions/session-transcript-worker-runtime.js");
  const resolved = await prepareSqliteTranscriptReadScope(params.scope);
  params.assertCurrent();
  const options = toDatabaseOptions(resolved);
  const scope = {
    ...params.scope,
    agentId: resolved.agentId,
    storePath: resolveOpenClawAgentSqlitePath(options),
  };
  const admission = resolveSessionTranscriptReadFence(resolved);
  return withSessionHistoryWorkerDatabase(options, async (owner) => {
    const read = async () => {
      params.assertCurrent();
      const source = await owner.readActivitySummarySource({
        scope,
        previous: params.previous,
        admission,
      });
      params.assertCurrent();
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
        const cleaned = redactToolPayloadText(text ?? "")
          .replace(/\s+/gu, " ")
          .trim();
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
