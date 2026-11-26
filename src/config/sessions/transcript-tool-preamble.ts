import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { isToolCallContentType, resolveToolUseId } from "../../chat/tool-content.js";
import type { AgentEventPayload } from "../../infra/agent-events.js";
import { extractAssistantPhaseText } from "../../shared/chat-message-content.js";

/** Only this run, root call and delivered native row can stand in for a lost input anchor. */
export type TranscriptPreambleSource = { runId: string; toolCallId: string; messageId: string };

/** Locate the delivered row that owns a run's cumulative prefix, not a later reply with the same words. */
export function findTranscriptToolPreamble(
  run: { runId: string; text: string; events?: readonly AgentEventPayload[] },
  beforeEvent: number,
  readPage: () => readonly unknown[],
  source?: TranscriptPreambleSource,
) {
  if (source && source.runId !== run.runId) {
    return undefined;
  }
  const ends = new Map<string, number>();
  for (const event of run.events?.slice(0, beforeEvent) ?? []) {
    const { data } = event;
    if (
      event.runId === run.runId &&
      event.stream === "tool" &&
      data.phase === "start" &&
      !data.parentToolCallId &&
      typeof data.toolCallId === "string" &&
      typeof data.bufferEnd === "number" &&
      Number.isSafeInteger(data.bufferEnd) &&
      data.bufferEnd > 0 &&
      data.bufferEnd <= run.text.length
    ) {
      ends.set(data.toolCallId, data.bufferEnd);
    }
  }
  // Keep worker pages opaque unless a root call actually marked this buffer.
  if (!ends.size) {
    return undefined;
  }
  let anchored = Boolean(source);
  let previous: { index: number; id: string | null; text: string } | undefined;
  let end = 0;
  let proof: TranscriptPreambleSource | undefined;
  const indices: number[] = [];
  for (const [index, message] of readPage().entries()) {
    const row = asOptionalRecord(message);
    const identity = readSessionMessageIdentity(message);
    if (identity?.role === "user") {
      if (indices.length) {
        break;
      }
      anchored = identity.runId === run.runId;
    }
    if (
      !anchored ||
      row?.provider !== "claude-cli" ||
      identity?.role !== "assistant" ||
      !identity.isImported ||
      (identity.runId && identity.runId !== run.runId)
    ) {
      previous = undefined;
      continue;
    }
    if (previous && Array.isArray(row.content)) {
      for (const value of row.content) {
        const block = asOptionalRecord(value);
        const call = block && isToolCallContentType(block.type) && resolveToolUseId(block);
        const next = call && ends.get(call);
        if (
          !call ||
          !next ||
          next <= end ||
          (!end && source && (source.messageId !== previous.id || source.toolCallId !== call))
        ) {
          continue;
        }
        // Reconstruct only exact bytes, from a whole prefix or adjacent witnessed paragraphs.
        if (next === previous.text.length && run.text.startsWith(previous.text)) {
          indices.length = 0;
        } else if (!end || run.text.slice(end, next) !== "\n\n" + previous.text) {
          continue;
        }
        if (!indices.length) {
          proof = previous.id
            ? { runId: run.runId, messageId: previous.id, toolCallId: call }
            : undefined;
        }
        indices.push(previous.index);
        end = next;
        break;
      }
    }
    const text = extractAssistantPhaseText(message);
    previous = text ? { index, id: identity.id, text } : undefined;
  }
  return indices.length
    ? { messageIndex: indices.length === 1 ? indices[0] : indices, end, source: proof }
    : undefined;
}
