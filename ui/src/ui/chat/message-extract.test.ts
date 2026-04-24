import { describe, expect, it } from "vitest";
import {
  extractText,
  extractTextCached,
  extractThinking,
  extractThinkingCached,
} from "./message-extract.ts";

const INTERNAL_RUNTIME_CONTEXT_BLOCK = [
  "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
  "OpenClaw runtime context (internal):",
  "This context is runtime-generated, not user-authored. Keep internal details private.",
  "",
  "[Internal task completion event]",
  "source: subagent",
  "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
].join("\n");

const PROMPT_PROSE =
  "Pre-compaction memory flush. Store durable memories only in memory/2026-04-24.md.";

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

  it("does not expose assistant internal runtime context", () => {
    const message = {
      role: "assistant",
      content: INTERNAL_RUNTIME_CONTEXT_BLOCK,
    };

    expect(extractText(message)).toBe("");
    expect(extractTextCached(message)).toBe("");
  });

  it("preserves assistant prompt prose that is not structured control text", () => {
    const message = {
      role: "assistant",
      content: PROMPT_PROSE,
    };

    expect(extractText(message)).toBe(PROMPT_PROSE);
    expect(extractTextCached(message)).toBe(PROMPT_PROSE);
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
