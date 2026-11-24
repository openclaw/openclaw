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
  const start =
    beforeEvent > 0 &&
    run.events?.findLast((event, index) => {
      const { stream, runId, data } = event;
      const end = data.bufferEnd;
      return (
        index < beforeEvent &&
        stream === "tool" &&
        data.phase === "start" &&
        !data.parentToolCallId &&
        typeof data.toolCallId === "string" &&
        runId === run.runId &&
        (!source || (source.runId === runId && source.toolCallId === data.toolCallId)) &&
        typeof end === "number" &&
        Number.isSafeInteger(end) &&
        end > 0 &&
        end <= run.text.length
      );
    });
  const end = start && start.data.bufferEnd;
  const toolCallId = start && start.data.toolCallId;
  if (!start || typeof end !== "number" || typeof toolCallId !== "string") {
    return undefined;
  }
  const prefix = run.text.slice(0, end);
  let anchored = Boolean(source);
  let previous: { index: number; messageId: string | null } | undefined;
  // Do not decode a worker page unless this run actually marked a root call.
  for (const [index, message] of readPage().entries()) {
    const row = asOptionalRecord(message);
    const identity = readSessionMessageIdentity(message);
    if (identity?.role === "user") {
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
    if (
      previous &&
      Array.isArray(row.content) &&
      row.content.some((value) => {
        const block = asOptionalRecord(value);
        return block && isToolCallContentType(block.type) && resolveToolUseId(block) === toolCallId;
      })
    ) {
      const { index: messageIndex, messageId } = previous;
      return {
        messageIndex,
        end,
        source: messageId ? { runId: run.runId, toolCallId, messageId } : undefined,
      };
    }
    previous =
      (!source || identity.id === source.messageId) && extractAssistantPhaseText(message) === prefix
        ? { index, messageId: identity.id }
        : undefined;
  }
  return undefined;
}
