import { describe, expect, it } from "vitest";
import { analyzePromptQuality, buildPromptQualityTemplate } from "./prompt-quality.ts";

describe("prompt quality guidance", () => {
  it("flags short vague task prompts", () => {
    const result = analyzePromptQuality("fix this");

    expect(result.level).toBe("review");
    expect(result.issues.map((issue) => issue.key)).toEqual([
      "too-short",
      "vague-reference",
      "missing-context",
      "missing-outcome",
    ]);
  });

  it("lets direct commands and casual replies pass through", () => {
    expect(analyzePromptQuality("/status").level).toBe("ready");
    expect(analyzePromptQuality("thanks").level).toBe("ready");
  });

  it("treats attached context as enough context for compact prompts", () => {
    const result = analyzePromptQuality("explain this image", { hasAttachments: true });

    expect(result.issues.map((issue) => issue.key)).not.toContain("vague-reference");
    expect(result.issues.map((issue) => issue.key)).not.toContain("missing-context");
  });

  it("builds a structured prompt scaffold without replacing the user's task", () => {
    expect(buildPromptQualityTemplate("review the card")).toContain("review the card");
    expect(buildPromptQualityTemplate("review the card")).toContain("Context:");
    expect(buildPromptQualityTemplate("review the card")).toContain("When done:");
  });
});
