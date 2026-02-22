import { describe, expect, test } from "vitest";
import { stripEnvelopeFromMessage } from "./chat-sanitize.js";

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

  test("removes Conversation info metadata block", () => {
    const input = {
      role: "user",
      content: `Conversation info (untrusted metadata):
\`\`\`json
{ "message_id": "123", "sender": "user" }
\`\`\`

Hello!`,
    };
    const result = stripEnvelopeFromMessage(input) as { content?: string };
    expect(result.content).toBe("Hello!");
  });

  test("removes Sender metadata block", () => {
    const input = {
      role: "user",
      content: `Sender (untrusted metadata):
\`\`\`json
{ "name": "Alice" }
\`\`\`

Test message`,
    };
    const result = stripEnvelopeFromMessage(input) as { content?: string };
    expect(result.content).toBe("Test message");
  });

  test("removes Thread starter metadata block", () => {
    const input = {
      role: "user",
      content: `Thread starter (untrusted, for context):
\`\`\`json
{ "thread_id": "456" }
\`\`\`

Reply text`,
    };
    const result = stripEnvelopeFromMessage(input) as { content?: string };
    expect(result.content).toBe("Reply text");
  });

  test("removes Replied message metadata block", () => {
    const input = {
      role: "user",
      content: `Replied message (untrusted, for context):
\`\`\`json
{ "original": "hi" }
\`\`\`

My reply`,
    };
    const result = stripEnvelopeFromMessage(input) as { content?: string };
    expect(result.content).toBe("My reply");
  });

  test("removes Forwarded message context metadata block", () => {
    const input = {
      role: "user",
      content: `Forwarded message context (untrusted metadata):
\`\`\`json
{ "from": "Bob" }
\`\`\`

Forwarded content`,
    };
    const result = stripEnvelopeFromMessage(input) as { content?: string };
    expect(result.content).toBe("Forwarded content");
  });

  test("removes Chat history metadata block", () => {
    const input = {
      role: "user",
      content: `Chat history since last reply (untrusted, for context):
\`\`\`json
[{ "msg": "previous" }]
\`\`\`

New message`,
    };
    const result = stripEnvelopeFromMessage(input) as { content?: string };
    expect(result.content).toBe("New message");
  });

  test("removes multiple metadata blocks", () => {
    const input = {
      role: "user",
      content: `Conversation info (untrusted metadata):
\`\`\`json
{ "id": "1" }
\`\`\`

Sender (untrusted metadata):
\`\`\`json
{ "name": "User" }
\`\`\`

Final message`,
    };
    const result = stripEnvelopeFromMessage(input) as { content?: string };
    expect(result.content).toBe("Final message");
  });

  test("removes envelope prefix and metadata block together", () => {
    const input = {
      role: "user",
      content: `[WebChat 2026-02-21 10:00] Conversation info (untrusted metadata):
\`\`\`json
{ "message_id": "999" }
\`\`\`

Actual text`,
    };
    const result = stripEnvelopeFromMessage(input) as { content?: string };
    expect(result.content).toBe("Actual text");
  });
});
