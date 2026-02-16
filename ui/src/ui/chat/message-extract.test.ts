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

describe("extractText strips directive tags from assistant messages", () => {
  it("strips [[reply_to_current]]", () => {
    const message = {
      role: "assistant",
      content: "Hello there [[reply_to_current]]",
    };
    expect(extractText(message)).toBe("Hello there");
  });

  it("strips [[reply_to:<id>]]", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "Done [[reply_to: abc123]]" }],
    };
    expect(extractText(message)).toBe("Done");
  });

  it("strips [[audio_as_voice]]", () => {
    const message = {
      role: "assistant",
      content: "Listen up [[audio_as_voice]]",
    };
    expect(extractText(message)).toBe("Listen up");
  });

  it("does not strip tags from user messages", () => {
    const message = {
      role: "user",
      content: "Hello [[reply_to_current]]",
    };
    expect(extractText(message)).toBe("Hello [[reply_to_current]]");
  });

  it("strips tag from .text property", () => {
    const message = {
      role: "assistant",
      text: "Hi [[reply_to_current]]",
    };
    expect(extractText(message)).toBe("Hi");
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
