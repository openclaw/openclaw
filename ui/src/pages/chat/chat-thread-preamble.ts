import { readAssistantStreamSegmentIdentity } from "@openclaw/gateway-client/browser";
import { flattenMarkdownToPlainText } from "@openclaw/normalization-core/markdown-plain-text";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { extractAssistantTextForPhase } from "../../../../src/shared/chat-message-content.js";
import { streamSegmentHasItemId, type ChatStreamSegment } from "../../lib/chat/chat-types.ts";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import { rawMessageTimestamp, sanitizeStreamText } from "./chat-thread-items.ts";
import { transcriptRunId } from "./chat-thread-run-identity.ts";

export function latestWorkingPreamble(
  props: { messages: readonly unknown[]; streamSegments: readonly ChatStreamSegment[] },
  runId: string | null | undefined,
) {
  if (!runId) {
    return undefined;
  }
  let latest: { text: string; timestamp: number; itemId?: string; message?: unknown } | undefined;
  // Read before the history visibility filter: a durable mirror can replace
  // its live segment even when Keep commentary is off.
  for (const message of props.messages) {
    if (asRecord(message)?.role !== "assistant" || transcriptRunId(message) !== runId) {
      continue;
    }
    const identity = readAssistantStreamSegmentIdentity(message);
    const text = identity
      ? extractTextCached(message)
      : extractAssistantTextForPhase(message, { phase: "commentary" });
    const timestamp = rawMessageTimestamp(message) ?? 0;
    if (text && (!latest || timestamp >= latest.timestamp)) {
      latest = { text, timestamp, itemId: identity?.itemId, message };
    }
  }
  for (const segment of props.streamSegments) {
    if (
      segment.runId === runId &&
      streamSegmentHasItemId(segment) &&
      segment.text.trim() &&
      (!latest || segment.ts > latest.timestamp)
    ) {
      latest = { text: segment.text, timestamp: segment.ts, itemId: segment.itemId };
    }
  }
  if (!latest) {
    return undefined;
  }
  const text = truncateUtf16Safe(flattenMarkdownToPlainText(sanitizeStreamText(latest.text)), 800);
  return text ? { ...latest, text } : undefined;
}
