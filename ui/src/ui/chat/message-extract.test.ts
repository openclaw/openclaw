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

  it("strips <final> tags from assistant content", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "<final>Hello</final>" }],
    };
    expect(extractText(message)).toBe("Hello");
    expect(extractTextCached(message)).toBe("Hello");
  });

  it("strips multiline <final> blocks from assistant content", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "<final>\n\nHello there\n\n</final>" }],
    };
    expect(extractText(message)).toBe("Hello there\n\n");
    expect(extractTextCached(message)).toBe("Hello there\n\n");
  });

  it("strips mixed <think> and <final> tags from assistant content", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "<think>reasoning\n</think>\n\n<final>Hello</final>" }],
    };
    expect(extractText(message)).toBe("Hello");
    expect(extractTextCached(message)).toBe("Hello");
  });

  it("strips <final> tags from assistant text property", () => {
    const message = {
      role: "assistant",
      text: "<final>Hello world</final>",
    };
    expect(extractText(message)).toBe("Hello world");
    expect(extractTextCached(message)).toBe("Hello world");
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
