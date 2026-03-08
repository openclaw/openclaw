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

  it("strips assistant relevant-memories scaffolding", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: [
            "<relevant-memories>",
            "Internal memory context",
            "</relevant-memories>",
            "Final user answer",
          ].join("\n"),
        },
      ],
    };
    expect(extractText(message)).toBe("Final user answer");
    expect(extractTextCached(message)).toBe("Final user answer");
  });

  it("falls back to assistant errorMessage when no text blocks exist", () => {
    const message = {
      role: "assistant",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      stopReason: "error",
      errorMessage: "401 unauthorized",
      content: [],
    };
    expect(extractText(message)).toBe("anthropic/claude-sonnet-4-5: 401 unauthorized");
    expect(extractTextCached(message)).toBe("anthropic/claude-sonnet-4-5: 401 unauthorized");
  });

  it("renders a generic fallback when assistant stopReason is error but details are empty", () => {
    const message = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "",
      content: [],
    };
    expect(extractText(message)).toBe("No error details were provided by the model.");
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
