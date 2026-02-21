import { describe, expect, test } from "vitest";
import { stripInboundUserContext } from "./chat-envelope.js";

describe("stripInboundUserContext", () => {
  test("returns text unchanged when no metadata present", () => {
    expect(stripInboundUserContext("Hello world")).toBe("Hello world");
  });

  test("strips a single conversation info block", () => {
    const input = [
      "Conversation info (untrusted metadata):",
      "```json",
      JSON.stringify({ message_id: "abc", sender: "+1234" }, null, 2),
      "```",
      "",
      "Hello world",
    ].join("\n");
    expect(stripInboundUserContext(input)).toBe("Hello world");
  });

  test("strips multiple metadata blocks", () => {
    const input = [
      "Conversation info (untrusted metadata):",
      "```json",
      JSON.stringify({ message_id: "abc" }, null, 2),
      "```",
      "",
      "Sender (untrusted metadata):",
      "```json",
      JSON.stringify({ label: "Alice", name: "Alice" }, null, 2),
      "```",
      "",
      "How are you?",
    ].join("\n");
    expect(stripInboundUserContext(input)).toBe("How are you?");
  });

  test("strips 'untrusted, for context' blocks", () => {
    const input = [
      "Replied message (untrusted, for context):",
      "```json",
      JSON.stringify({ sender_label: "Bob", body: "hi" }, null, 2),
      "```",
      "",
      "Reply text here",
    ].join("\n");
    expect(stripInboundUserContext(input)).toBe("Reply text here");
  });

  test("strips forwarded message context block", () => {
    const input = [
      "Forwarded message context (untrusted metadata):",
      "```json",
      JSON.stringify({ from: "Charlie", type: "user" }, null, 2),
      "```",
      "",
      "Forwarded content",
    ].join("\n");
    expect(stripInboundUserContext(input)).toBe("Forwarded content");
  });

  test("strips chat history block", () => {
    const input = [
      "Chat history since last reply (untrusted, for context):",
      "```json",
      JSON.stringify([{ sender: "Alice", timestamp_ms: 123, body: "hi" }], null, 2),
      "```",
      "",
      "Latest message",
    ].join("\n");
    expect(stripInboundUserContext(input)).toBe("Latest message");
  });

  test("strips thread starter block", () => {
    const input = [
      "Thread starter (untrusted, for context):",
      "```json",
      JSON.stringify({ body: "thread start" }, null, 2),
      "```",
      "",
      "My reply",
    ].join("\n");
    expect(stripInboundUserContext(input)).toBe("My reply");
  });

  test("strips all block types combined", () => {
    const input = [
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
      "Thread starter (untrusted, for context):",
      "```json",
      JSON.stringify({ body: "start" }, null, 2),
      "```",
      "",
      "Replied message (untrusted, for context):",
      "```json",
      JSON.stringify({ body: "quoted" }, null, 2),
      "```",
      "",
      "Chat history since last reply (untrusted, for context):",
      "```json",
      JSON.stringify([{ sender: "Bob", body: "msg" }], null, 2),
      "```",
      "",
      "The actual user message",
    ].join("\n");
    expect(stripInboundUserContext(input)).toBe("The actual user message");
  });

  test("returns empty string when text is only metadata", () => {
    const input = [
      "Conversation info (untrusted metadata):",
      "```json",
      JSON.stringify({ message_id: "abc" }, null, 2),
      "```",
    ].join("\n");
    expect(stripInboundUserContext(input)).toBe("");
  });

  test("does not strip blocks in the middle of user text", () => {
    const input = [
      "User message first",
      "",
      "Conversation info (untrusted metadata):",
      "```json",
      JSON.stringify({ message_id: "abc" }, null, 2),
      "```",
    ].join("\n");
    expect(stripInboundUserContext(input)).toBe(input);
  });

  test("preserves multiline user text after metadata", () => {
    const input = [
      "Conversation info (untrusted metadata):",
      "```json",
      JSON.stringify({ message_id: "abc" }, null, 2),
      "```",
      "",
      "Line one",
      "Line two",
      "",
      "Line three",
    ].join("\n");
    expect(stripInboundUserContext(input)).toBe("Line one\nLine two\n\nLine three");
  });

  test("handles text containing '(untrusted' string but no metadata blocks", () => {
    const input = "The user said (untrusted data) is fine";
    expect(stripInboundUserContext(input)).toBe(input);
  });
});
