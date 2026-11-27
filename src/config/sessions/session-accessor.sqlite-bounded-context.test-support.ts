import { transcriptMessage } from "./transcript-message.test-support.js";

export function user(id: string, parent: string | null, content = id) {
  return transcriptMessage(id, parent, { role: "user", content });
}

export function assistant(id: string, parent: string | null, content = id) {
  return transcriptMessage(id, parent, { role: "assistant", content });
}

export function toolResult(id: string, parent: string, call: string, text: string, second: number) {
  return transcriptMessage(id, parent, {
    role: "toolResult",
    toolCallId: call,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.UTC(2026, 7, 15, 0, 0, second),
  });
}

export function storedMessage(
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  content: string,
) {
  return { type: "message", id, parentId, message: { role, content } };
}

export function compaction(
  id: string,
  parentId: string,
  firstKeptEntryId: string,
  summary: string,
) {
  return {
    type: "compaction",
    id,
    parentId,
    firstKeptEntryId,
    summary,
    timestamp: "2026-08-30T00:00:00.000Z",
    tokensBefore: 100,
  };
}

export function reset(id: string, parentId: string, firstKeptEntryId?: string) {
  return {
    type: "reset",
    id,
    parentId,
    firstKeptEntryId,
    reason: "new",
    timestamp: "2026-08-30T00:00:00.000Z",
  };
}
