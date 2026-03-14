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

  it("strips user relevant-memories via displayStripPatterns from messageMeta", () => {
    const message = {
      role: "user",
      content: "<relevant-memories>\n1. [personal] likes coffee\n</relevant-memories>\nHello world",
      messageMeta: {
        displayStripPatterns: [
          {
            regex:
              "<\\s*relevant[-_]memories\\b[^>]*>[\\s\\S]*?<\\s*/\\s*relevant[-_]memories\\s*>\\s*",
          },
        ],
      },
    };
    expect(extractText(message)).toBe("Hello world");
  });

  it("strips user relevant-memories via hardcoded fallback when no messageMeta", () => {
    const message = {
      role: "user",
      content:
        "<relevant-memories>\n1. [personal] likes coffee\n</relevant-memories>\nWhat is 2+2?",
    };
    expect(extractText(message)).toBe("What is 2+2?");
  });

  it("strips both relevant-memories and timestamp envelope injected by prependContext", () => {
    // When autoRecall is active, prependContext pushes <relevant-memories>
    // before the timestamp envelope, so both must be stripped.
    const message = {
      role: "user",
      content:
        "<relevant-memories>\n1. [personal] likes coffee\n</relevant-memories>\n\n[Sun 2026-03-15 10:30 CST] Hello world",
      messageMeta: {
        displayStripPatterns: [
          {
            regex:
              "<\\s*relevant[-_]memories\\b[^>]*>[\\s\\S]*?<\\s*/\\s*relevant[-_]memories\\s*>\\s*",
          },
        ],
      },
    };
    expect(extractText(message)).toBe("Hello world");
  });

  it("strips relevant-memories and timestamp envelope without messageMeta", () => {
    const message = {
      role: "user",
      content:
        "<relevant-memories>\n1. [fact] sky is blue\n</relevant-memories>\n\n[Mon 2026-01-28 20:30 EST] What is up?",
    };
    expect(extractText(message)).toBe("What is up?");
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
