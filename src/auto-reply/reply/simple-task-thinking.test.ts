import { describe, expect, it } from "vitest";
import { isSimpleTaskTurn, maybeHintLowThinkingForSimpleTurn } from "./simple-task-thinking.js";

describe("isSimpleTaskTurn", () => {
  it("returns true for short single-line prompts", () => {
    expect(isSimpleTaskTurn("what's the weather in sf?")).toBe(true);
    expect(isSimpleTaskTurn("status")).toBe(true);
  });

  it("returns false for multiline prompts", () => {
    expect(isSimpleTaskTurn("first do x\nthen do y")).toBe(false);
  });

  it("returns false for structured/code-like prompts", () => {
    expect(isSimpleTaskTurn('parse this JSON: {"a":1}')).toBe(false);
    expect(isSimpleTaskTurn("```ts\nconsole.log('x')\n```")).toBe(false);
    expect(isSimpleTaskTurn("see https://example.com and summarize")).toBe(false);
  });

  it("returns false for long prompts", () => {
    expect(
      isSimpleTaskTurn(
        "Please help me draft a detailed migration plan for replacing our deployment system across environments with phased rollout and risk analysis.",
      ),
    ).toBe(false);
  });

  it("returns false when word count exceeds MAX_SIMPLE_WORDS (20) even if under char limit", () => {
    // Construct a prompt with 21 short words but short enough to stay under 140 chars
    const twentyOneWords = "a b c d e f g h i j k l m n o p q r s t u";
    expect(twentyOneWords.split(/\s+/).length).toBe(21);
    expect(twentyOneWords.length).toBeLessThan(140);
    expect(isSimpleTaskTurn(twentyOneWords)).toBe(false);
  });

  it("returns true at exactly MAX_SIMPLE_WORDS (20 words)", () => {
    const twentyWords = "a b c d e f g h i j k l m n o p q r s t";
    expect(twentyWords.split(/\s+/).length).toBe(20);
    expect(isSimpleTaskTurn(twentyWords)).toBe(true);
  });

  it("returns false when prompt contains '{' (object/code hint)", () => {
    expect(isSimpleTaskTurn("try calling run { check }")).toBe(false);
  });

  it("returns false when prompt contains '}' (object/code hint)", () => {
    expect(isSimpleTaskTurn("close the block }")).toBe(false);
  });

  it("returns false when prompt contains '=>' (arrow function)", () => {
    expect(isSimpleTaskTurn("use fn => result")).toBe(false);
  });

  it("returns false when prompt contains '$(' (shell substitution)", () => {
    expect(isSimpleTaskTurn("run $(date) please")).toBe(false);
  });
});

describe("maybeHintLowThinkingForSimpleTurn", () => {
  it("downgrades adaptive to low for simple turns", () => {
    expect(
      maybeHintLowThinkingForSimpleTurn({
        resolvedThinkLevel: "adaptive",
        hasExplicitThinkDirective: false,
        baseBodyTrimmedRaw: "status",
      }),
    ).toBe("low");
  });

  it("preserves explicit think directives", () => {
    expect(
      maybeHintLowThinkingForSimpleTurn({
        resolvedThinkLevel: "adaptive",
        hasExplicitThinkDirective: true,
        baseBodyTrimmedRaw: "status",
      }),
    ).toBe("adaptive");
  });

  it("preserves non-adaptive levels", () => {
    expect(
      maybeHintLowThinkingForSimpleTurn({
        resolvedThinkLevel: "high",
        hasExplicitThinkDirective: false,
        baseBodyTrimmedRaw: "status",
      }),
    ).toBe("high");
  });
});
