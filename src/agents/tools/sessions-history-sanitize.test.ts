import { describe, expect, it } from "vitest";
import { sanitizeHistoryMessage } from "./sessions-history-sanitize.js";

describe("sanitizeHistoryMessage", () => {
  it("strips reasoning blocks from returned assistant messages", () => {
    const result = sanitizeHistoryMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private chain of thought", thinkingSignature: "sig" },
        { type: "redacted_thinking", data: "sealed" },
        { type: "text", text: "public answer" },
      ],
    });

    expect(result.truncated).toBe(true);
    expect(result.message).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "public answer" }],
    });

    const serialized = JSON.stringify(result.message);
    expect(serialized).not.toContain("private chain of thought");
    expect(serialized).not.toContain("redacted_thinking");
    expect(serialized).not.toContain("thinkingSignature");
  });

  it("preserves assistant turn structure when all content blocks are reasoning-only", () => {
    const result = sanitizeHistoryMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private chain of thought" },
        { type: "redacted_thinking", data: "sealed" },
      ],
    });

    expect(result.truncated).toBe(true);
    expect(result.message).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "" }],
    });
  });
});
