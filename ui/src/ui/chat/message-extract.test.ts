import { describe, expect, it } from "vitest";
import {
  extractText,
  extractTextCached,
  extractThinking,
  extractThinkingCached,
} from "./message-extract.ts";

describe("extractTextCached", () => {
  it("matches extractText output", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "Hello there" }],
    };
    expect(extractTextCached(message)).toBe(extractText(message));
  });

  it("returns consistent output for repeated calls", () => {
    const message = {
      role: "user",
      content: "plain text",
    };
    expect(extractTextCached(message)).toBe("plain text");
    expect(extractTextCached(message)).toBe("plain text");
  });
});

describe("extractText", () => {
  it("filters out empty text blocks to avoid extra newlines", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "First part" },
        { type: "tool_use", id: "t1", name: "read", input: {} },
        { type: "text", text: "" },
        { type: "text", text: "Second part" },
      ],
    };
    const result = extractText(message);
    expect(result).toBe("First part\nSecond part");
  });

  it("handles content with only empty text blocks", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "" },
        { type: "tool_use", id: "t1", name: "read", input: {} },
      ],
    };
    expect(extractText(message)).toBeNull();
  });
});

describe("extractThinkingCached", () => {
  it("matches extractThinking output", () => {
    const message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Plan A" }],
    };
    expect(extractThinkingCached(message)).toBe(extractThinking(message));
  });

  it("returns consistent output for repeated calls", () => {
    const message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Plan A" }],
    };
    expect(extractThinkingCached(message)).toBe("Plan A");
    expect(extractThinkingCached(message)).toBe("Plan A");
  });
});
