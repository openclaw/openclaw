import { afterEach, describe, expect, it } from "vitest";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import {
  calculateCost,
  clampThinkingLevel,
  getSupportedThinkingLevels,
  resetModelCostWarningStateForTest,
} from "./model-utils.js";
import type { Model, Usage } from "./types.js";

function makeThinkingModel(
  thinkingLevelMap: Model["thinkingLevelMap"],
  overrides: Partial<Model> = {},
): Model {
  return {
    id: "test-model",
    name: "Test Model",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://example.com",
    reasoning: true,
    thinkingLevelMap,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
    ...overrides,
  };
}

function makeCostModel(
  overrides: Partial<Model<"anthropic-messages">> = {},
): Model<"anthropic-messages"> {
  return {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
    ...overrides,
  };
}

function makeUsage(overrides: Partial<Usage> = {}): Usage {
  return {
    input: 881,
    output: 6,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 887,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  };
}

describe("calculateCost", () => {
  afterEach(() => {
    resetModelCostWarningStateForTest();
  });

  it("calculates cost from per-million token pricing", () => {
    const usage = makeUsage();

    const cost = calculateCost(
      makeCostModel({
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      }),
      usage,
    );

    expect(cost.input).toBeCloseTo(0.002643);
    expect(cost.output).toBeCloseTo(0.00009);
    expect(cost.cacheRead).toBe(0);
    expect(cost.cacheWrite).toBe(0);
    expect(cost.total).toBeCloseTo(0.002733);
  });

  it("warns when token usage is charged against a model without known pricing", async () => {
    const capture = createWarnLogCapture("model-cost-unknown-pricing");

    try {
      calculateCost(makeCostModel(), makeUsage());

      await expect(
        capture.findText(
          "unknown model pricing for anthropic/claude-opus-4-8; usage.cost numeric fields will remain zero",
        ),
      ).resolves.toBeDefined();
    } finally {
      capture.cleanup();
    }
  });

  it("does not warn for zero pricing before any token usage exists", async () => {
    const capture = createWarnLogCapture("model-cost-no-token-usage");

    try {
      calculateCost(makeCostModel(), makeUsage({ input: 0, output: 0, totalTokens: 0 }));

      await expect(capture.findText("unknown model pricing")).resolves.toBeUndefined();
    } finally {
      capture.cleanup();
    }
  });
});

describe("clampThinkingLevel", () => {
  it("downgrades explicit extended-level opt-outs", () => {
    expect(clampThinkingLevel(makeThinkingModel({ xhigh: null, max: "max" }), "xhigh")).toBe(
      "high",
    );
  });

  it("keeps upward clamping for lower-level map holes", () => {
    expect(clampThinkingLevel(makeThinkingModel({ minimal: null }), "minimal")).toBe("low");
  });

  it("honors canonical Fable capabilities when catalog reasoning is stale", () => {
    const model = makeThinkingModel(undefined, {
      id: "company-fable",
      api: "anthropic-messages",
      provider: "microsoft-foundry",
      reasoning: false,
      params: { canonicalModelId: "claude-fable-5" },
    });

    expect(getSupportedThinkingLevels(model)).toContain("max");
    expect(clampThinkingLevel(model, "max")).toBe("max");
  });
});
