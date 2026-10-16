import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionActivitySummaryBatchInput,
  SessionActivitySummaryBatchResult,
} from "../config/sessions/activity-summary-source.types.js";
import { readSessionActorCompleteTranscriptFromReplica } from "../config/sessions/session-actor-replica.js";
import { hasTranscriptMessage } from "../config/sessions/session-transcript-projection-append.js";
import {
  ACTIVITY_SUMMARY_MAX_BYTES,
  selectActivitySummaryBatch,
} from "./session-activity-summary-batch.js";

/** Complete linear context already has the worker's stored byte lengths and active path. */
export function readActivitySummaryBatchFromReplica(
  params: SessionActivitySummaryBatchInput,
): SessionActivitySummaryBatchResult {
  const { scope } = params;
  if (!scope.storePath || !scope.sessionKey) {
    return undefined;
  }
  const current = readSessionActorCompleteTranscriptFromReplica({
    path: scope.storePath,
    sessionKey: scope.sessionKey,
    sessionId: scope.sessionId,
  });
  if (!current) {
    return undefined;
  }
  const messages = current.rows.filter(
    ({ event }) => isRecord(event) && event.type !== "session" && hasTranscriptMessage(event),
  );
  return structuredClone(
    selectActivitySummaryBatch({
      previous: params.previous,
      snapshot: {
        totalMessages: messages.length,
        activeLeafEntryId: current.activeLeafEntryId,
        snapshot: { generation: current.snapshot.transcript.version.generation ?? undefined },
      },
      watermark: current.snapshot.transcript.watermark,
      isOnActivePath: (entryId) =>
        current.rows.some(
          ({ event }) => isRecord(event) && event.type !== "session" && event.id === entryId,
        ),
      readPage: (start, count, includeEarlier = false) => {
        const end = start + count;
        // Replica sizes include the JSONL newline; SQL classifies payload bytes alone.
        const hasOversizedMessages = messages
          .slice(includeEarlier ? 0 : start, end)
          .some(
            ({ event, serializedBytes }) =>
              serializedBytes > ACTIVITY_SUMMARY_MAX_BYTES &&
              isRecord(event) &&
              isRecord(event.message) &&
              (event.message.role === "user" || event.message.role === "assistant"),
          );
        const events: { event: unknown }[] = [];
        let bytes = 0;
        for (let index = end - 1; index >= start; index -= 1) {
          const row = messages[index]!;
          if (bytes + row.serializedBytes <= ACTIVITY_SUMMARY_MAX_BYTES) {
            events.push({ event: row.event });
            bytes += row.serializedBytes;
          }
        }
        return { events: events.toReversed(), scannedMessages: count, hasOversizedMessages };
      },
    }),
  );
}
