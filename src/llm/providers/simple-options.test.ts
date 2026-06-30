import { describe, expect, it } from "vitest";
import { adjustMaxTokensForThinking, clampReasoning } from "./simple-options.js";

describe("clampReasoning", () => {
  it("maps ultra to the strongest budgeted simple level", () => {
    expect(clampReasoning("ultra")).toBe("max");
  });

  it("preserves the existing xhigh clamp", () => {
    expect(clampReasoning("xhigh")).toBe("high");
  });
});

describe("adjustMaxTokensForThinking", () => {
  it("uses a safe max budget for ultra", () => {
    expect(adjustMaxTokensForThinking(undefined, 50_000, "ultra")).toEqual({
      maxTokens: 50_000,
      thinkingBudget: 32_768,
    });
  });

  it("keeps output headroom when ultra budget would exceed the caller cap", () => {
    expect(adjustMaxTokensForThinking(1_000, 4_096, "ultra")).toEqual({
      maxTokens: 4_096,
      thinkingBudget: 3_072,
    });
  });
});
