import { afterEach, describe, expect, it } from "vitest";
import {
  clearMemoryFlushPlanResolver,
  getMemoryFlushPlanResolver,
  registerMemoryFlushPlanResolver,
  resolveMemoryFlushPlan,
  restoreMemoryFlushPlanResolver,
} from "./flush-plan.js";

describe("memory flush plan registry", () => {
  afterEach(() => {
    clearMemoryFlushPlanResolver();
  });

  it("returns null when no resolver is registered", () => {
    expect(resolveMemoryFlushPlan({})).toBeNull();
  });

  it("uses the registered resolver", () => {
    registerMemoryFlushPlanResolver(() => ({
      softThresholdTokens: 1,
      forceFlushTranscriptBytes: 2,
      reserveTokensFloor: 3,
      prompt: "prompt",
      systemPrompt: "system",
      relativePath: "memory/test.md",
    }));

    expect(resolveMemoryFlushPlan({})?.relativePath).toBe("memory/test.md");
  });

  it("restoreMemoryFlushPlanResolver swaps resolver state", () => {
    registerMemoryFlushPlanResolver(() => ({
      softThresholdTokens: 1,
      forceFlushTranscriptBytes: 2,
      reserveTokensFloor: 3,
      prompt: "first",
      systemPrompt: "first",
      relativePath: "memory/first.md",
    }));
    const current = getMemoryFlushPlanResolver();

    clearMemoryFlushPlanResolver();
    expect(resolveMemoryFlushPlan({})).toBeNull();

    restoreMemoryFlushPlanResolver(current);
    expect(resolveMemoryFlushPlan({})?.relativePath).toBe("memory/first.md");
  });
});
