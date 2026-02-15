import { describe, expect, test } from "vitest";
import { stripEnvelopeFromMessage, truncateMessagesForChatHistory } from "./chat-sanitize.js";

describe("stripEnvelopeFromMessage", () => {
  test("removes message_id hint lines from user messages", () => {
    const input = {
      role: "user",
      content: "[WhatsApp 2026-01-24 13:36] yolo\n[message_id: 7b8b]",
    };
    const result = stripEnvelopeFromMessage(input) as { content?: string };
    expect(result.content).toBe("yolo");
  });

  test("removes message_id hint lines from text content arrays", () => {
    const input = {
      role: "user",
      content: [{ type: "text", text: "hi\n[message_id: abc123]" }],
    };
    const result = stripEnvelopeFromMessage(input) as {
      content?: Array<{ type: string; text?: string }>;
    };
    expect(result.content?.[0]?.text).toBe("hi");
  });

  test("does not strip inline message_id text that is part of a line", () => {
    const input = {
      role: "user",
      content: "I typed [message_id: 123] on purpose",
    };
    const result = stripEnvelopeFromMessage(input) as { content?: string };
    expect(result.content).toBe("I typed [message_id: 123] on purpose");
  });

  test("does not strip assistant messages", () => {
    const input = {
      role: "assistant",
      content: "note\n[message_id: 123]",
    };
    const result = stripEnvelopeFromMessage(input) as { content?: string };
    expect(result.content).toBe("note\n[message_id: 123]");
  });
});

describe("truncateMessagesForChatHistory", () => {
  const bigText = "x".repeat(60_000);

  test("truncates string content exceeding 50K chars", () => {
    const messages = [{ role: "assistant", content: bigText }];
    const [result] = truncateMessagesForChatHistory(messages) as Array<{ content: string }>;
    expect(result.content.length).toBeLessThan(bigText.length);
    expect(result.content).toContain("… [content truncated for display]");
  });

  test("truncates text entries in content arrays", () => {
    const messages = [{ role: "assistant", content: [{ type: "text", text: bigText }] }];
    const [result] = truncateMessagesForChatHistory(messages) as Array<{
      content: Array<{ type: string; text: string }>;
    }>;
    expect(result.content[0].text.length).toBeLessThan(bigText.length);
    expect(result.content[0].text).toContain("… [content truncated for display]");
  });

  test("truncates top-level text field", () => {
    const messages = [{ role: "assistant", text: bigText }];
    const [result] = truncateMessagesForChatHistory(messages) as Array<{ text: string }>;
    expect(result.text.length).toBeLessThan(bigText.length);
  });

  test("returns same array reference when nothing is truncated", () => {
    const messages = [{ role: "user", content: "short" }];
    const result = truncateMessagesForChatHistory(messages);
    expect(result).toBe(messages);
  });

  test("returns empty array unchanged", () => {
    const result = truncateMessagesForChatHistory([]);
    expect(result).toEqual([]);
  });
});
