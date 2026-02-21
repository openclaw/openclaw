import { describe, expect, test } from "vitest";
import { stripEnvelopeFromMessage, stripEnvelopeFromMessages } from "./chat-sanitize.js";

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

  test("strips inbound user context metadata from string content", () => {
    const metadata = [
      "Conversation info (untrusted metadata):",
      "```json",
      JSON.stringify({ message_id: "abc", sender: "+1234" }, null, 2),
      "```",
    ].join("\n");
    const input = {
      role: "user",
      content: `${metadata}\n\nHello world`,
    };
    const result = stripEnvelopeFromMessage(input) as { content?: string };
    expect(result.content).toBe("Hello world");
  });

  test("strips inbound user context metadata from content array", () => {
    const metadata = [
      "Sender (untrusted metadata):",
      "```json",
      JSON.stringify({ label: "Alice", name: "Alice" }, null, 2),
      "```",
    ].join("\n");
    const input = {
      role: "user",
      content: [{ type: "text", text: `${metadata}\n\nHi there` }],
    };
    const result = stripEnvelopeFromMessage(input) as {
      content?: Array<{ type: string; text?: string }>;
    };
    expect(result.content?.[0]?.text).toBe("Hi there");
  });

  test("strips multiple metadata blocks from user message", () => {
    const input = {
      role: "user",
      content: [
        "Conversation info (untrusted metadata):",
        "```json",
        JSON.stringify({ message_id: "abc" }, null, 2),
        "```",
        "",
        "Sender (untrusted metadata):",
        "```json",
        JSON.stringify({ label: "Alice" }, null, 2),
        "```",
        "",
        "Chat history since last reply (untrusted, for context):",
        "```json",
        JSON.stringify([{ sender: "Bob", body: "hey" }], null, 2),
        "```",
        "",
        "What is the weather?",
      ].join("\n"),
    };
    const result = stripEnvelopeFromMessage(input) as { content?: string };
    expect(result.content).toBe("What is the weather?");
  });

  test("does not strip inbound context from assistant messages", () => {
    const metadata = [
      "Conversation info (untrusted metadata):",
      "```json",
      JSON.stringify({ message_id: "abc" }, null, 2),
      "```",
    ].join("\n");
    const input = {
      role: "assistant",
      content: `${metadata}\n\nSome text`,
    };
    const result = stripEnvelopeFromMessage(input) as { content?: string };
    expect(result.content).toBe(`${metadata}\n\nSome text`);
  });
});

describe("stripEnvelopeFromMessages", () => {
  test("strips metadata from user messages in a conversation", () => {
    const metadata = [
      "Conversation info (untrusted metadata):",
      "```json",
      JSON.stringify({ message_id: "m1" }, null, 2),
      "```",
    ].join("\n");
    const messages = [
      { role: "user", content: `${metadata}\n\nHello` },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: `${metadata}\n\nHow are you?` },
    ];
    const result = stripEnvelopeFromMessages(messages) as Array<{ content: string }>;
    expect(result[0].content).toBe("Hello");
    expect(result[1].content).toBe("Hi there!");
    expect(result[2].content).toBe("How are you?");
  });
});
