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

describe("extractText strips reply tags from assistant messages", () => {
  it("strips [[reply_to_current]] from assistant string content", () => {
    const message = {
      role: "assistant",
      content: "[[reply_to_current]] Hello there",
    };
    expect(extractText(message)).toBe("Hello there");
  });

  it("strips [[reply_to_current]] from assistant content array", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "[[reply_to_current]] Hello there" }],
    };
    expect(extractText(message)).toBe("Hello there");
  });

  it("strips [[reply_to:<id>]] from assistant messages", () => {
    const message = {
      role: "assistant",
      content: "[[reply_to: msg_123]] Hello there",
    };
    expect(extractText(message)).toBe("Hello there");
  });

  it("strips [[audio_as_voice]] from assistant messages", () => {
    const message = {
      role: "assistant",
      content: "[[audio_as_voice]] Hello there",
    };
    expect(extractText(message)).toBe("Hello there");
  });

  it("strips reply tag from assistant .text field", () => {
    const message = {
      role: "assistant",
      text: "[[reply_to_current]] Hello there",
    };
    expect(extractText(message)).toBe("Hello there");
  });

  it("does not strip reply tags from user messages", () => {
    const message = {
      role: "user",
      content: "[[reply_to_current]] Hello there",
    };
    expect(extractText(message)).toBe("[[reply_to_current]] Hello there");
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
