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
