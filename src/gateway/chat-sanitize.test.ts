import { describe, it, expect } from "vitest";
import {
  stripEnvelopeFromMessage,
  stripEnvelopeFromMessages,
} from "./chat-sanitize.js";

describe("stripEnvelopeFromMessage", () => {
  it("should return non-object values as-is", () => {
    expect(stripEnvelopeFromMessage(null)).toBe(null);
    expect(stripEnvelopeFromMessage(undefined)).toBe(undefined);
    expect(stripEnvelopeFromMessage("string")).toBe("string");
    expect(stripEnvelopeFromMessage(123)).toBe(123);
    expect(stripEnvelopeFromMessage(true)).toBe(true);
  });

  it("should return message unchanged if no content to strip", () => {
    const message = { role: "user", content: "Hello world" };
    expect(stripEnvelopeFromMessage(message)).toBe(message);
  });

  it("should strip envelope from user message content", () => {
    const message = {
      role: "user",
      content: "Hello [envelope:123] world",
    };
    const result = stripEnvelopeFromMessage(message) as { content: string };
    expect(result.content).toBe("Hello  world");
  });

  it("should not strip envelope from non-user message", () => {
    const message = {
      role: "assistant",
      content: "Hello [envelope:123] world",
    };
    const result = stripEnvelopeFromMessage(message);
    expect(result).toBe(message);
  });

  it("should handle array content", () => {
    const message = {
      role: "user",
      content: [
        { type: "text", text: "Hello [envelope:123]" },
        { type: "image", url: "http://example.com/image.png" },
      ],
    };
    const result = stripEnvelopeFromMessage(message) as { content: Array<{ text?: string }> };
    expect(result.content[0].text).toBe("Hello ");
  });

  it("should handle text field instead of content", () => {
    const message = {
      role: "user",
      text: "Hello [envelope:123] world",
    };
    const result = stripEnvelopeFromMessage(message) as { text: string };
    expect(result.text).toBe("Hello  world");
  });

  it("should extract sender label from content", () => {
    const message = {
      role: "user",
      content: "[sender:John] Hello world",
    };
    const result = stripEnvelopeFromMessage(message) as { senderLabel: string };
    expect(result.senderLabel).toBe("John");
  });

  it("should extract sender label from array content", () => {
    const message = {
      role: "user",
      content: [{ type: "text", text: "[sender:Alice] Hello" }],
    };
    const result = stripEnvelopeFromMessage(message) as { senderLabel: string };
    expect(result.senderLabel).toBe("Alice");
  });

  it("should use existing senderLabel if present", () => {
    const message = {
      role: "user",
      senderLabel: "Existing",
      content: "[sender:New] Hello",
    };
    const result = stripEnvelopeFromMessage(message) as { senderLabel: string };
    expect(result.senderLabel).toBe("Existing");
  });

  it("should handle role case insensitively", () => {
    const message = {
      role: "USER",
      content: "Hello [envelope:123]",
    };
    const result = stripEnvelopeFromMessage(message) as { content: string };
    expect(result.content).toBe("Hello ");
  });

  it("should handle empty content array", () => {
    const message = {
      role: "user",
      content: [],
    };
    const result = stripEnvelopeFromMessage(message);
    expect(result).toBe(message);
  });

  it("should handle content array with non-object items", () => {
    const message = {
      role: "user",
      content: ["string", 123, null],
    };
    const result = stripEnvelopeFromMessage(message);
    expect(result).toBe(message);
  });

  it("should handle content array with non-text type", () => {
    const message = {
      role: "user",
      content: [{ type: "image", url: "http://example.com/image.png" }],
    };
    const result = stripEnvelopeFromMessage(message);
    expect(result).toBe(message);
  });

  it("should return same object if no changes made", () => {
    const message = { role: "assistant", content: "Hello" };
    const result = stripEnvelopeFromMessage(message);
    expect(result).toBe(message);
  });

  it("should handle complex nested content", () => {
    const message = {
      role: "user",
      content: [
        { type: "text", text: "Part 1 [envelope:1]" },
        { type: "text", text: "Part 2 [envelope:2]" },
        { type: "image", url: "http://example.com/image.png" },
      ],
    };
    const result = stripEnvelopeFromMessage(message) as { content: Array<{ text?: string }> };
    expect(result.content[0].text).toBe("Part 1 ");
    expect(result.content[1].text).toBe("Part 2 ");
  });
});

describe("stripEnvelopeFromMessages", () => {
  it("should return empty array as-is", () => {
    const messages: unknown[] = [];
    expect(stripEnvelopeFromMessages(messages)).toBe(messages);
  });

  it("should process multiple messages", () => {
    const messages = [
      { role: "user", content: "Hello [envelope:1]" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "How are you [envelope:2]?" },
    ];
    const result = stripEnvelopeFromMessages(messages) as Array<{ content: string }>;
    expect(result[0].content).toBe("Hello ");
    expect(result[1].content).toBe("Hi there");
    expect(result[2].content).toBe("How are you ?");
  });

  it("should return same array if no changes", () => {
    const messages = [
      { role: "assistant", content: "Hello" },
      { role: "system", content: "System message" },
    ];
    const result = stripEnvelopeFromMessages(messages);
    expect(result).toBe(messages);
  });

  it("should handle mixed content types", () => {
    const messages = [
      { role: "user", content: "Text [envelope:1]" },
      { role: "user", content: [{ type: "text", text: "Array [envelope:2]" }] },
      { role: "user", text: "Text field [envelope:3]" },
    ];
    const result = stripEnvelopeFromMessages(messages) as Array<{ content?: unknown; text?: string }>;
    expect(result[0].content).toBe("Text ");
    expect((result[1].content as Array<{ text: string }>)[0].text).toBe("Array ");
    expect(result[2].text).toBe("Text field ");
  });
});
