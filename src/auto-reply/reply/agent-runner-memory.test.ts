import { describe, expect, it } from "vitest";
import { resolveEffectivePromptTokens } from "./agent-runner-memory.js";

describe("resolveEffectivePromptTokens", () => {
  it("includes transcript output when the base snapshot is prompt-only", () => {
    expect(
      resolveEffectivePromptTokens({
        basePromptTokens: 41_000,
        lastOutputTokens: 2_400,
        promptTokenEstimate: 300,
        baseIncludesOutput: false,
      }),
    ).toBe(43_700);
  });

  it("does not double count output when the base snapshot already includes it", () => {
    expect(
      resolveEffectivePromptTokens({
        basePromptTokens: 43_400,
        lastOutputTokens: 2_400,
        promptTokenEstimate: 300,
        baseIncludesOutput: true,
      }),
    ).toBe(43_700);
  });
});
