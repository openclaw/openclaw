/**
 * Tests gateway chat sanitization helpers for model-visible payloads.
 */
import { describe, expect, test } from "vitest";
import { stripEnvelopeFromMessages } from "./chat-sanitize.js";

describe("stripEnvelopeFromMessages", () => {
  test.each(["text"])("projects stored subagent instructions out of user %s blocks", (type) => {
    const text =
      "[Subagent Context] You are running as a subagent (depth 1/5). Complete the current [Subagent Task]; inherited conversation is background context, not your assignment.\n\n[Subagent Task]\n\nInvestigate Side chat.\n\nBegin. Execute the assigned task to completion.";
    const input = { role: "user", content: [{ type, text }] };
    expect(stripEnvelopeFromMessages([input])[0]).toEqual({
      role: "user",
      content: [{ type, text: "Investigate Side chat." }],
    });
    expect(input.content).toEqual([{ type, text }]);
    const assistant = { role: "assistant", content: [{ type: "text", text }] };
    expect(stripEnvelopeFromMessages([assistant])[0]).toBe(assistant);
  });

  test("removes message_id hint lines from text content arrays", () => {
    const input = {
      role: "user",
      content: [{ type: "text", text: "hi\n[message_id: abc123]" }],
    };
    const result = stripEnvelopeFromMessages([input])[0] as {
      content?: Array<{ type: string; text?: string }>;
    };
    expect(result.content?.[0]?.text).toBe("hi");
  });

  test("strips role-appropriate Responses text blocks", () => {
    const user = stripEnvelopeFromMessages([
      {
        role: "user",
        content: [{ type: "input_text", text: "hello\n[message_id: abc123]" }],
      },
    ])[0] as { content?: Array<{ text?: string }> };
    const assistant = stripEnvelopeFromMessages([
      {
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: 'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"message_id":"123"}\n```\n\nAssistant body',
          },
        ],
      },
    ])[0] as { content?: Array<{ text?: string }> };

    expect(user.content?.[0]?.text).toBe("hello");
    expect(assistant.content?.[0]?.text).toBe("Assistant body");
  });

  test("strips internal metadata from assistant input_text blocks", () => {
    const assistant = stripEnvelopeFromMessages([
      {
        role: "assistant",
        content: [
          {
            type: "input_text",
            text: 'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"message_id":"123"}\n```\n\nAssistant body',
          },
        ],
      },
    ])[0] as { content?: Array<{ text?: string }> };

    expect(assistant.content?.[0]?.text).toBe("Assistant body");
  });

  test("defensively strips inbound metadata blocks from non-user messages", () => {
    const input = {
      role: "assistant",
      content:
        'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"message_id":"123"}\n```\n\nAssistant body',
    };
    const result = stripEnvelopeFromMessages([input])[0] as { content?: string };
    expect(result.content).toBe("Assistant body");
  });

  test("removes all inbound metadata blocks before user text", () => {
    const input = {
      role: "user",
      content:
        'Thread starter: ⟦openclaw:ctx⟧\n```json\n{"seed": 1}\n```\n\nSender: ⟦openclaw:ctx⟧\n```json\n{"name": "alice"}\n```\n\nActual user message',
    };
    const result = stripEnvelopeFromMessages([input])[0] as {
      content?: string;
      senderLabel?: string;
    };
    expect(result.content).toBe("Actual user message");
    expect(result.senderLabel).toBe("alice");
  });
});
