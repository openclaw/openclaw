// Covers per-message history replacement, including the sentinel that prevents
// oversized metadata from escaping through the ordinary placeholder.
import { describe, expect, it } from "vitest";
import { replaceOversizedChatHistoryMessages } from "./chat-history-budget.js";

type DisplayMessage = {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
};

function firstText(messages: unknown[]): string {
  const msg = messages[0] as DisplayMessage | undefined;
  return msg?.content?.[0]?.text ?? "";
}

describe("replaceOversizedChatHistoryMessages", () => {
  it("passes through history that already fits the per-message budget", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    const result = replaceOversizedChatHistoryMessages({
      messages,
      maxSingleMessageBytes: 1_000_000,
    });
    expect(result.messages).toEqual(messages);
  });

  it("returns the empty array unchanged for empty input", () => {
    const result = replaceOversizedChatHistoryMessages({
      messages: [],
      maxSingleMessageBytes: 10,
    });
    expect(result.messages).toEqual([]);
  });

  it("replaces an oversized message and preserves its cursor and run metadata", () => {
    const transcriptPosition = { source: "snapshot", rawSeq: 9 };
    const last = {
      role: "assistant",
      timestamp: 1,
      content: [{ type: "text", text: "y".repeat(4000) }],
      __openclaw: { id: "abc", seq: 7, runId: "run", turnBoundary: true, transcriptPosition },
    };
    const result = replaceOversizedChatHistoryMessages({
      messages: [last],
      maxSingleMessageBytes: 2_000,
    });
    expect(result.messages).toHaveLength(1);
    expect(firstText(result.messages)).toContain("chat.history omitted: message too large");
    expect(
      (result.messages[0] as { __openclaw?: { turnBoundary?: boolean } })["__openclaw"]
        ?.turnBoundary,
    ).toBe(true);
    expect(result.messages[0]).toMatchObject({ __openclaw: { transcriptPosition, runId: "run" } });
    // The placeholder is a new object, not the oversized original.
    expect(result.messages[0]).not.toBe(last);
  });

  it("returns a metadata-free sentinel when even the placeholder is over budget", () => {
    // A pathological message whose oversized-placeholder copy is itself too
    // large because it carries very large transcript metadata.
    const hugeId = "z".repeat(4000);
    const message = {
      role: "user",
      timestamp: 1,
      content: [{ type: "text", text: "hi" }],
      __openclaw: { id: hugeId, seq: 1 },
    };
    const result = replaceOversizedChatHistoryMessages({
      messages: [message],
      maxSingleMessageBytes: 1_000,
    });

    // The critical guarantee: the dashboard never receives an empty history.
    expect(result.messages).toHaveLength(1);
    expect(firstText(result.messages)).toContain("chat.history unavailable");
    // The sentinel does not carry the oversized source metadata.
    expect((result.messages[0] as Record<string, unknown>)["__openclaw"]).toBeUndefined();
  });
});

it("keeps oversized tool results recoverable with identity, error, and provenance", () => {
  const toolOutput = { source: "provider-response", modelInput: "unverified" };
  const [message] = replaceOversizedChatHistoryMessages({
    messages: [
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "read-call",
        isError: true,
        content: [{ type: "text", text: "x".repeat(4_000) }],
        __openclaw: { id: "durable-result", seq: 3, toolOutput },
      },
    ],
    maxSingleMessageBytes: 1_000,
  }).messages;
  expect(message).toMatchObject({
    role: "toolResult",
    toolName: "read",
    toolCallId: "read-call",
    isError: true,
    __openclaw: { id: "durable-result", seq: 3, toolOutput, truncated: true, reason: "oversized" },
  });
  expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThan(1_000);
});
