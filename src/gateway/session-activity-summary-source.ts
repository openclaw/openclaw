import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { SessionActivitySummary } from "../config/sessions/activity-summary.js";
import {
  readSessionTranscriptActivePathEntryRelation,
  readSessionTranscriptBoundedMessageTailPage,
  readSessionTranscriptWatermark,
  SessionTranscriptProjectionUnavailableError,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import {
  extractAssistantPhaseText,
  extractAssistantTextForPhase,
} from "../shared/chat-message-content.js";

/** Restore only this transcript, then read one chronological, byte-bounded batch. */
export async function readActivitySummarySource(params: {
  scope: Parameters<typeof readSessionTranscriptBoundedMessageTailPage>[0];
  previous?: SessionActivitySummary;
  assertCurrent: () => void;
}) {
  const { readRestoredSessionTranscript } =
    await import("../config/sessions/session-cold-storage-read.js");
  params.assertCurrent();
  const read = () => {
    params.assertCurrent();
    const snapshot = readSessionTranscriptBoundedMessageTailPage(params.scope, {
      maxBytes: 0,
      maxMessages: 0,
      offset: 0,
    });
    let previous = params.previous;
    if (
      previous &&
      (previous.generation !== (snapshot.snapshot.generation ?? null) ||
        previous.coveredMessages > snapshot.totalMessages ||
        (previous.leafEntryId &&
          !["exact", "ancestor"].includes(
            readSessionTranscriptActivePathEntryRelation(params.scope, previous.leafEntryId),
          )))
    ) {
      previous = undefined;
    }
    const watermark = readSessionTranscriptWatermark(params.scope);
    const covered = previous?.coveredMessages ?? 0;
    let batchSize = Math.min(64, snapshot.totalMessages - covered);
    let page = readSessionTranscriptBoundedMessageTailPage(params.scope, {
      maxBytes: 128 * 1024,
      maxMessages: batchSize,
      offset: snapshot.totalMessages - covered - batchSize,
    });
    while (batchSize > 1 && page.events.length < page.scannedMessages) {
      batchSize = Math.max(1, Math.floor(batchSize / 2));
      page = readSessionTranscriptBoundedMessageTailPage(params.scope, {
        maxBytes: 128 * 1024,
        maxMessages: batchSize,
        offset: snapshot.totalMessages - covered - batchSize,
      });
    }
    if (
      page.totalMessages !== snapshot.totalMessages ||
      page.snapshot.generation !== snapshot.snapshot.generation ||
      page.snapshot.indexedSeq !== snapshot.snapshot.indexedSeq
    ) {
      return undefined;
    }
    const omitted =
      (previous?.omittedContent ?? false) || page.events.length < page.scannedMessages;
    const notes = page.events
      .map(({ event }) => {
        const message = isRecord(event) ? event.message : undefined;
        if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant")) {
          return "";
        }
        const role = message.role;
        const text =
          role === "assistant"
            ? (extractAssistantPhaseText(message) ??
              extractAssistantTextForPhase(message, { phase: "commentary" }))
            : extractTextFromChatContent(message.content);
        if (!text) {
          return "";
        }
        const cleaned = redactToolPayloadText(text).replace(/\s+/gu, " ").trim();
        const excerpt =
          cleaned.length <= 800
            ? cleaned
            : `${sliceUtf16Safe(cleaned, 0, 395)} … ${sliceUtf16Safe(cleaned, -400)}`;
        return excerpt ? `${role}: ${excerpt}` : "";
      })
      .filter(Boolean);

    return { previous, snapshot, watermark, covered, page, omitted, notes };
  };
  try {
    return await readRestoredSessionTranscript(params.scope, read);
  } catch (error) {
    if (!(error instanceof SessionTranscriptProjectionUnavailableError)) {
      throw error;
    }
    await waitForSessionTranscriptProjection(params.scope);
    params.assertCurrent();
    return await readRestoredSessionTranscript(params.scope, read);
  }
}
