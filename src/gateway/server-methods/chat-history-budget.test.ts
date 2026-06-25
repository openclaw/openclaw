// Covers the chat.history final byte-budget fallback, including the sentinel
// that prevents an empty (blank) transcript from being returned to the dashboard.
import { describe, expect, it } from "vitest";
import { enforceChatHistoryFinalBudget } from "./chat.js";

type DisplayMessage = {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
};

function firstText(messages: unknown[]): string {
  const msg = messages[0] as DisplayMessage | undefined;
  return msg?.content?.[0]?.text ?? "";
}

describe("enforceChatHistoryFinalBudget", () => {
  it("passes through history that already fits the budget", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    const result = enforceChatHistoryFinalBudget({ messages, maxBytes: 1_000_000 });
    expect(result.messages).toEqual(messages);
    expect(result.omittedCount).toBe(0);
  });

  it("returns the empty array unchanged for empty input", () => {
    const result = enforceChatHistoryFinalBudget({ messages: [], maxBytes: 10 });
    expect(result.messages).toEqual([]);
    expect(result.omittedCount).toBe(0);
  });

  it("reports the dropped count when keeping only the last message", () => {
    const big = { role: "user", content: [{ type: "text", text: "x".repeat(4000) }] };
    const last = { role: "assistant", content: [{ type: "text", text: "ok" }] };
    const result = enforceChatHistoryFinalBudget({ messages: [big, last], maxBytes: 2_000 });
    expect(result.messages).toEqual([last]);
    // The earlier oversized message was dropped, so truncation must stay visible.
    expect(result.omittedCount).toBe(1);
  });

  it("counts every dropped message when only the last survives", () => {
    const big = { role: "user", content: [{ type: "text", text: "x".repeat(4000) }] };
    const mid = { role: "assistant", content: [{ type: "text", text: "x".repeat(4000) }] };
    const last = { role: "assistant", content: [{ type: "text", text: "ok" }] };
    const result = enforceChatHistoryFinalBudget({ messages: [big, mid, last], maxBytes: 2_000 });
    expect(result.messages).toEqual([last]);
    expect(result.omittedCount).toBe(2);
  });

  it("falls back to a small placeholder when even the last message is too large", () => {
    const last = {
      role: "assistant",
      timestamp: 1,
      content: [{ type: "text", text: "y".repeat(4000) }],
      __openclaw: { id: "abc", seq: 7 },
    };
    const result = enforceChatHistoryFinalBudget({ messages: [last], maxBytes: 2_000 });
    expect(result.messages).toHaveLength(1);
    expect(firstText(result.messages)).toContain("chat.history omitted: message too large");
    expect(result.omittedCount).toBe(1);
  });

  it("counts the whole list as omitted when the last message is replaced by a placeholder", () => {
    const earlier = { role: "user", content: [{ type: "text", text: "hi" }] };
    const last = {
      role: "assistant",
      timestamp: 1,
      content: [{ type: "text", text: "y".repeat(4000) }],
      __openclaw: { id: "abc", seq: 7 },
    };
    const result = enforceChatHistoryFinalBudget({ messages: [earlier, last], maxBytes: 2_000 });
    expect(result.messages).toHaveLength(1);
    expect(firstText(result.messages)).toContain("chat.history omitted: message too large");
    // No input message survives verbatim, so both are counted as omitted.
    expect(result.omittedCount).toBe(2);
  });

  it("returns a metadata-free sentinel (never an empty transcript) when even the placeholder is over budget", () => {
    // A pathological message whose oversized-placeholder copy is itself too
    // large because it carries very large transcript metadata.
    const hugeId = "z".repeat(4000);
    const message = {
      role: "user",
      timestamp: 1,
      content: [{ type: "text", text: "hi" }],
      __openclaw: { id: hugeId, seq: 1 },
    };
    const result = enforceChatHistoryFinalBudget({ messages: [message], maxBytes: 1_000 });

    // The critical guarantee: the dashboard never receives an empty history.
    expect(result.messages).toHaveLength(1);
    expect(firstText(result.messages)).toContain("chat.history unavailable");
    // The sentinel does not carry the oversized source metadata.
    expect((result.messages[0] as Record<string, unknown>)["__openclaw"]).toBeUndefined();
    expect(result.omittedCount).toBe(1);
  });
});
