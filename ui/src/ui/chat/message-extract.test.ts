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

describe("extractText — reply tag stripping", () => {
  it("strips [[reply_to_current]] from assistant messages", () => {
    const message = {
      role: "assistant",
      content: "[[reply_to_current]] Here is my response.",
    };
    expect(extractText(message)).toBe("Here is my response.");
  });

  it("strips [[reply_to: <id>]] from assistant messages", () => {
    const message = {
      role: "assistant",
      content: "[[reply_to: abc123]] Here is my response.",
    };
    expect(extractText(message)).toBe("Here is my response.");
  });

  it("strips reply tags with extra whitespace inside brackets", () => {
    const message = {
      role: "assistant",
      content: "[[ reply_to_current ]] Here is my response.",
    };
    expect(extractText(message)).toBe("Here is my response.");
  });

  it("does not strip reply tags from user messages", () => {
    const message = {
      role: "user",
      content: "[[reply_to_current]] some user text",
    };
    // user messages go through stripEnvelope, not stripReplyTags
    const result = extractText(message);
    expect(result).toContain("some user text");
  });

  it("strips reply tags from assistant content arrays", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "[[reply_to_current]] Here is my response." }],
    };
    expect(extractText(message)).toBe("Here is my response.");
  });
});
