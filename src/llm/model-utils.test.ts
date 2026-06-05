import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getSupportedThinkingLevels } from "./model-utils.js";
import type { Model } from "./types.js";

type OpenAICompatReasoningMetadata = {
  supportsReasoningEffort?: boolean;
  supportedReasoningEfforts?: string[];
  reasoningEffortMap?: Record<string, string | null>;
};

type TestOpenAICompletionsModel = Omit<Model<"openai-completions">, "compat"> & {
  compat?: Model<"openai-completions">["compat"] & OpenAICompatReasoningMetadata;
};

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

describe("model thinking levels", () => {
  it("exposes xhigh/max when an OpenAI-compatible model advertises xhigh reasoning effort", () => {
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
      "max",
    ]);
    expect(clampThinkingLevel(model, "xhigh")).toBe("xhigh");
    expect(clampThinkingLevel(model, "max")).toBe("max");
  });

  it("uses compat reasoning effort maps for extended thinking levels", () => {
    const model = {
      ...baseModel,
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "medium", "high"],
        reasoningEffortMap: {
          xhigh: "high",
          max: null,
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
