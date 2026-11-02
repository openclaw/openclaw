import { describe, expect, it } from "vitest";
import { answerLensRevision, readAnswerLensSource } from "./answer-lens.js";

describe("Answer Lens source eligibility", () => {
  it("never accepts user, tool, commentary or incomplete/error answers", () => {
    for (const role of ["user", "toolResult"]) {
      expect(readAnswerLensSource({ role, content: "private" })).toBeUndefined();
    }
    for (const stopReason of ["error", "aborted", "length", "toolUse"]) {
      expect(
        readAnswerLensSource({ role: "assistant", content: "partial", stopReason }),
      ).toBeUndefined();
    }
    expect(
      readAnswerLensSource({ role: "assistant", phase: "commentary", content: "working" }),
    ).toBeUndefined();
    expect(
      readAnswerLensSource({
        role: "assistant",
        content: [{ type: "thinking", thinking: "private" }],
      }),
    ).toBeUndefined();
  });
  it("preserves original whitespace and enforces the source size boundary", () => {
    const text = " Original\n\nanswer. ";
    expect(readAnswerLensSource({ role: "assistant", content: text })).toBe(text);
    expect(readAnswerLensSource({ role: "assistant", content: "a".repeat(32_000) })).toHaveLength(
      32_000,
    );
    expect(
      readAnswerLensSource({ role: "assistant", content: "a".repeat(32_001) }),
    ).toBeUndefined();
    expect(answerLensRevision(text)).not.toBe(answerLensRevision(text.trim()));
  });
});
