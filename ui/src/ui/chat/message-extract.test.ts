import { describe, expect, it } from "vitest";
import {
  extractText,
  extractTextCached,
  extractThinking,
  extractThinkingCached,
} from "./message-extract.ts";

describe("extractTextCached", () => {
  const SESSION_RECAP_BLOCK = `<session-recap>
<summary>Found 10 recent items across 3 categories</summary>
</session-recap>`;

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

  it("strips a leading session recap block from user messages", () => {
    const message = {
      role: "user",
      content: `${SESSION_RECAP_BLOCK}\n\nVisible user text`,
    };

    expect(extractText(message)).toBe("Visible user text");
    expect(extractTextCached(message)).toBe("Visible user text");
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
