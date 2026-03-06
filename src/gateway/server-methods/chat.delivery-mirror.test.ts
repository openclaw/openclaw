import { describe, expect, it } from "vitest";
import { __testing } from "./chat.js";

const { isDeliveryMirrorMessage, sanitizeChatHistoryMessages } = __testing;

describe("isDeliveryMirrorMessage", () => {
  it("returns true for delivery-mirror assistant entries", () => {
    expect(
      isDeliveryMirrorMessage({
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        content: [{ type: "text", text: "hello" }],
      }),
    ).toBe(true);
  });

  it("returns false for normal assistant entries", () => {
    expect(
      isDeliveryMirrorMessage({
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "hello" }],
      }),
    ).toBe(false);
  });

  it("returns false for user messages", () => {
    expect(
      isDeliveryMirrorMessage({
        role: "user",
        content: "hello",
      }),
    ).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isDeliveryMirrorMessage(null)).toBe(false);
    expect(isDeliveryMirrorMessage(undefined)).toBe(false);
  });
});

describe("sanitizeChatHistoryMessages filters delivery-mirror", () => {
  it("removes delivery-mirror entries from message list", () => {
    const messages = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Hello!" }],
      },
      {
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        content: [{ type: "text", text: "Hello!" }],
      },
    ];

    const result = sanitizeChatHistoryMessages(messages);
    expect(result).toHaveLength(2);
    expect(result.every((m: Record<string, unknown>) => m.model !== "delivery-mirror")).toBe(true);
  });

  it("returns original array when no delivery-mirror entries exist", () => {
    const messages = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "reply" }],
      },
    ];

    const result = sanitizeChatHistoryMessages(messages);
    expect(result).toBe(messages);
  });

  it("returns empty array unchanged", () => {
    const result = sanitizeChatHistoryMessages([]);
    expect(result).toHaveLength(0);
  });
});
