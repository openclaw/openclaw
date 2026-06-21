import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getSupportedThinkingLevels } from "./model-utils.js";
import type { Model } from "./types.js";

type TestOpenAICompletionsModel = Model<"openai-completions">;
type TestOpenAIResponsesModel = Model<"openai-responses">;

const baseModel = {
  id: "codex-lb-2455/gpt-5.5",
  name: "codex-lb-2455/gpt-5.5",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://example.test/v1",
  reasoning: true,
  input: ["text"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 128_000,
  maxTokens: 16_384,
} satisfies TestOpenAICompletionsModel;

const baseResponsesModel = {
  ...baseModel,
  api: "openai-responses",
} satisfies TestOpenAIResponsesModel;

function makeModel(
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

describe("model thinking levels", () => {
  it("downgrades explicit extended-level opt-outs", () => {
    expect(clampThinkingLevel(makeModel({ xhigh: null, max: "max" }), "xhigh")).toBe("high");
  });

  it("keeps upward clamping for lower-level map holes", () => {
    expect(clampThinkingLevel(makeModel({ minimal: null }), "minimal")).toBe("low");
  });

  it("honors canonical Fable capabilities when catalog reasoning is stale", () => {
    const model = makeModel(undefined, {
      id: "company-fable",
      api: "anthropic-messages",
      provider: "microsoft-foundry",
      reasoning: false,
      params: { canonicalModelId: "claude-fable-5" },
    });

    expect(getSupportedThinkingLevels(model)).toContain("max");
    expect(clampThinkingLevel(model, "max")).toBe("max");
  });

  it("exposes xhigh when an OpenAI-compatible model advertises xhigh reasoning effort", () => {
    const model = {
      ...baseModel,
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
      },
    } satisfies TestOpenAICompletionsModel;

    expect(getSupportedThinkingLevels(model)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(clampThinkingLevel(model, "xhigh")).toBe("xhigh");
    expect(clampThinkingLevel(model, "max")).toBe("xhigh");
  });

  it("uses explicit compat reasoning effort support for extended thinking levels", () => {
    const model = {
      ...baseModel,
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
        reasoningEffortMap: {
          xhigh: "xhigh",
        },
      },
    } satisfies TestOpenAICompletionsModel;

    expect(getSupportedThinkingLevels(model)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(clampThinkingLevel(model, "xhigh")).toBe("xhigh");
    expect(clampThinkingLevel(model, "max")).toBe("xhigh");
  });

  it("exposes xhigh when compat maps it to a provider-supported effort", () => {
    const model = {
      ...baseModel,
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "medium", "high"],
        reasoningEffortMap: {
          xhigh: "high",
        },
      },
    } satisfies TestOpenAICompletionsModel;

    expect(getSupportedThinkingLevels(model)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(clampThinkingLevel(model, "xhigh")).toBe("xhigh");
    expect(clampThinkingLevel(model, "max")).toBe("xhigh");
  });

  it("exposes xhigh for OpenAI Responses models when compat maps it to a provider-supported effort", () => {
    const model = {
      ...baseResponsesModel,
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "medium", "high"],
        reasoningEffortMap: {
          xhigh: "high",
        },
      },
    } satisfies TestOpenAIResponsesModel;

    expect(getSupportedThinkingLevels(model)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(clampThinkingLevel(model, "xhigh")).toBe("xhigh");
    expect(clampThinkingLevel(model, "max")).toBe("xhigh");
  });

  it("respects OpenAI Responses explicit compat reasoning effort disablement", () => {
    const model = {
      ...baseResponsesModel,
      compat: {
        supportsReasoningEffort: false,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
      },
    } satisfies TestOpenAIResponsesModel;

    expect(getSupportedThinkingLevels(model)).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(clampThinkingLevel(model, "xhigh")).toBe("high");
  });

  it("keeps map-only compat aliases out of visible thinking levels", () => {
    const model = {
      ...baseModel,
      thinkingLevelMap: {
        off: null,
        high: "high",
      },
      compat: {
        supportsReasoningEffort: true,
        reasoningEffortMap: {
          xhigh: "high",
          max: "high",
        },
      },
    } satisfies TestOpenAICompletionsModel;

    expect(getSupportedThinkingLevels(model)).toEqual(["minimal", "low", "medium", "high"]);
    expect(clampThinkingLevel(model, "xhigh")).toBe("high");
    expect(clampThinkingLevel(model, "max")).toBe("high");
  });

  it("exposes max only when compat metadata explicitly maps max to xhigh", () => {
    const model = {
      ...baseModel,
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
        reasoningEffortMap: {
          max: "xhigh",
        },
      },
    } satisfies TestOpenAICompletionsModel;

    expect(getSupportedThinkingLevels(model)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(clampThinkingLevel(model, "max")).toBe("max");
  });

  it("keeps provider-native max hidden without an explicit xhigh alias map", () => {
    const model = {
      ...baseModel,
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "medium", "high", "max"],
      },
    } satisfies TestOpenAICompletionsModel;

    expect(getSupportedThinkingLevels(model)).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(clampThinkingLevel(model, "max")).toBe("high");
  });

  it("respects explicit compat reasoning effort disablement", () => {
    const model = {
      ...baseModel,
      compat: {
        supportsReasoningEffort: false,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
        reasoningEffortMap: {
          max: "xhigh",
        },
      },
    } satisfies TestOpenAICompletionsModel;

    expect(getSupportedThinkingLevels(model)).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(clampThinkingLevel(model, "xhigh")).toBe("high");
    expect(clampThinkingLevel(model, "max")).toBe("high");
  });

  it("keeps xhigh hidden for reasoning models without explicit extended support", () => {
    expect(getSupportedThinkingLevels(baseModel)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(clampThinkingLevel(baseModel, "xhigh")).toBe("high");
  });
});
