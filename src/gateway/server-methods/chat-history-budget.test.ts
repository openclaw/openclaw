import { describe, expect, it } from "vitest";
import { replaceOversizedChatHistoryMessages } from "./chat-history-budget.js";

function replace(messages: unknown[], maxSingleMessageBytes = 1_000) {
  return replaceOversizedChatHistoryMessages({ messages, maxSingleMessageBytes }).messages;
}

describe("replaceOversizedChatHistoryMessages", () => {
  it("passes through history that already fits the per-message budget", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    expect(replace(messages, 1_000_000)).toEqual(messages);
  });

  it("returns the empty array unchanged for empty input", () => {
    expect(replace([], 10)).toEqual([]);
  });

  it("replaces an oversized message and preserves its cursor and run metadata", () => {
    const transcriptPosition = { source: "snapshot", rawSeq: 9 };
    const last = {
      role: "assistant",
      timestamp: 1,
      content: [{ type: "text", text: "y".repeat(4000) }],
      __openclaw: { id: "abc", seq: 7, runId: "run", turnBoundary: true, transcriptPosition },
    };
    const messages = replace([last], 2_000);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      content: [{ text: expect.stringContaining("chat.history omitted: message too large") }],
      __openclaw: { turnBoundary: true, transcriptPosition, runId: "run" },
    });
    expect(messages[0]).not.toBe(last);
  });

  it("returns a metadata-free sentinel when even the placeholder is over budget", () => {
    const message = {
      role: "user",
      timestamp: 1,
      content: [{ type: "text", text: "hi" }],
      __openclaw: { id: "z".repeat(4000), seq: 1 },
    };
    const messages = replace([message]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      content: [{ text: expect.stringContaining("chat.history unavailable") }],
    });
    expect(messages[0]).not.toHaveProperty("__openclaw");
  });
});

it("keeps oversized tool results recoverable with identity, error, and provenance", () => {
  const toolOutput = { source: "provider-response", modelInput: "unverified" };
  const [message] = replace([
    {
      role: "toolResult",
      toolName: "read",
      toolCallId: "read-call",
      isError: true,
      content: [{ type: "text", text: "x".repeat(4_000) }],
      __openclaw: { id: "durable-result", seq: 3, toolOutput },
    },
  ]);
  expect(message).toMatchObject({
    role: "toolResult",
    toolName: "read",
    toolCallId: "read-call",
    isError: true,
    __openclaw: { id: "durable-result", seq: 3, toolOutput, truncated: true, reason: "oversized" },
  });
  expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThan(1_000);
});
