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

  it("prefers final_answer assistant text over commentary text", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "thinking like caveman",
          textSignature: JSON.stringify({ v: 1, id: "msg_commentary", phase: "commentary" }),
        },
        {
          type: "text",
          text: "Actual final answer",
          textSignature: JSON.stringify({ v: 1, id: "msg_final", phase: "final_answer" }),
        },
      ],
    };
    expect(extractText(message)).toBe("Actual final answer");
    expect(extractTextCached(message)).toBe("Actual final answer");
  });

  it("does not render commentary-only assistant text", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "thinking like caveman",
          textSignature: JSON.stringify({ v: 1, id: "msg_commentary", phase: "commentary" }),
        },
      ],
    };
    expect(extractText(message)).toBeNull();
    expect(extractTextCached(message)).toBeNull();
  });

  it("strips leading system-event prompt prefixes from user text", () => {
    const message = {
      role: "user",
      content: [
        {
          type: "text",
          text:
            "System (untrusted): [Mon 2026-04-13 09:30:01 EDT] Exec completed (abc12345, code 0) :: npm test\n" +
            "System (untrusted): stdout: all green\n\n" +
            "Please summarize the result",
        },
      ],
    };
    expect(extractText(message)).toBe("Please summarize the result");
    expect(extractTextCached(message)).toBe("Please summarize the result");
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
