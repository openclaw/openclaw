import { describe, expect, it } from "vitest";
import {
  extractText,
  extractTextCached,
  extractThinking,
  extractThinkingCached,
  processMessageText,
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

describe("processMessageText", () => {
  it("strips <think>/<final> scaffolding for assistant role", () => {
    const input = "<think>reasoning</think>\n\n<final>Hello</final>";
    expect(processMessageText(input, "assistant")).toBe("Hello");
  });

  it("strips empty <think></think> with surrounding whitespace", () => {
    const input = "<think> </think> <final> 好的，主人。已完成 </final>";
    expect(processMessageText(input, "assistant")).toContain("好的，主人。已完成");
    expect(processMessageText(input, "assistant")).not.toContain("<final>");
    expect(processMessageText(input, "assistant")).not.toContain("<think>");
  });

  it("strips inbound metadata blocks for user role", () => {
    const input = [
      "Sender (untrusted metadata):",
      "```json",
      '{"id": "u1"}',
      "```",
      "",
      "Actual user text",
    ].join("\n");
    expect(processMessageText(input, "user")).toBe("Actual user text");
  });

  it("leaves plain user text untouched", () => {
    expect(processMessageText("Hello Kokoro", "user")).toBe("Hello Kokoro");
  });

  it("leaves plain assistant text untouched", () => {
    expect(processMessageText("Plain reply", "assistant")).toBe("Plain reply");
  });
});
