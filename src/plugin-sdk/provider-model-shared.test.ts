/**
 * Tests shared provider model helpers.
 */
import { describe, expect, it } from "vitest";
import {
  buildProviderReplayFamilyHooks,
  modelCostsEqual,
  NATIVE_ANTHROPIC_REPLAY_HOOKS,
  PASSTHROUGH_GEMINI_REPLAY_HOOKS,
  resolveClaudeFable5ModelIdentity,
  resolveClaudeMythos5ModelIdentity,
  resolveClaudeOpus5ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
  resolveClaudeThinkingProfile,
  requiresClaudeDefaultSampling,
  selectPreferredLocalModelId,
  supportsClaude1MContext,
  supportsClaudeAdaptiveThinking,
  supportsClaudeFastMode,
  supportsClaudeNativeMaxEffort,
  supportsClaudeNativeXhighEffort,
} from "./provider-model-shared.js";

const EXPECTED_COST = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

function readLevelIds(profile: unknown): string[] {
  const levels = (profile as { levels?: Array<{ id?: unknown }> } | undefined)?.levels;
  expect(Array.isArray(levels)).toBe(true);
  return (levels ?? []).map((level) => String(level.id));
}

describe("Claude model contracts", () => {
  it("recognizes Vertex date suffixes", () => {
    expect(resolveClaudeFable5ModelIdentity({ id: "claude-fable-5@20260601" })).toBe(
      "claude-fable-5@20260601",
    );
    expect(supportsClaudeAdaptiveThinking({ id: "claude-sonnet-4-6@20260301" })).toBe(true);
    expect(supportsClaudeNativeXhighEffort({ id: "claude-opus-4-8@20260401" })).toBe(true);
    expect(resolveClaudeOpus5ModelIdentity({ id: "claude-opus-5@20260701" })).toBe(
      "claude-opus-5@20260701",
    );
    expect(resolveClaudeSonnet5ModelIdentity({ id: "claude-sonnet-5@20260701" })).toBe(
      "claude-sonnet-5@20260701",
    );
  });

  it("recognizes Claude Mythos 5 as mandatory adaptive with native max effort", () => {
    expect(resolveClaudeMythos5ModelIdentity({ id: "us.anthropic.claude-mythos-5-v1:0" })).toBe(
      "claude-mythos-5-v1:0",
    );
    expect(supportsClaudeAdaptiveThinking({ id: "claude-mythos-5" })).toBe(true);
    expect(supportsClaudeNativeMaxEffort({ id: "claude-mythos-5" })).toBe(true);
    expect(supportsClaudeNativeXhighEffort({ id: "anthropic.claude-mythos-5" })).toBe(true);
    expect(requiresClaudeDefaultSampling({ id: "claude-mythos-5" })).toBe(true);
  });

  it.each([["OpenRouter", { id: "anthropic/claude-opus-5" }, "claude-opus-5"]] as const)(
    "recognizes the Claude Opus 5 contract through %s",
    (_provider, ref, identity) => {
      expect(resolveClaudeOpus5ModelIdentity(ref)).toBe(identity);
      expect(supportsClaude1MContext(ref)).toBe(true);
      expect(supportsClaudeAdaptiveThinking(ref)).toBe(true);
      expect(supportsClaudeNativeMaxEffort(ref)).toBe(true);
      expect(supportsClaudeNativeXhighEffort(ref)).toBe(true);
      expect(requiresClaudeDefaultSampling(ref)).toBe(true);
    },
  );

  it("recognizes native fast-mode Claude models", () => {
    expect(supportsClaudeFastMode({ id: "claude-opus-5" })).toBe(true);
    expect(supportsClaudeFastMode({ id: "opus" })).toBe(true);
    expect(supportsClaudeFastMode({ id: "opus-5" })).toBe(true);
    expect(supportsClaudeFastMode({ id: "global.anthropic.claude-opus-5" })).toBe(true);
    expect(supportsClaudeFastMode({ id: "claude-opus-4.8" })).toBe(true);
    expect(supportsClaudeFastMode({ id: "claude-opus-4-7" })).toBe(false);
    expect(supportsClaudeFastMode({ id: "claude-opus-50" })).toBe(false);
  });

  it("does not classify later numeric model versions as supported aliases", () => {
    expect(supportsClaudeAdaptiveThinking({ id: "claude-sonnet-4-60" })).toBe(false);
    expect(supportsClaudeAdaptiveThinking({ id: "claude-sonnet-50" })).toBe(false);
    expect(supportsClaudeAdaptiveThinking({ id: "claude-mythos-50" })).toBe(false);
    expect(supportsClaudeAdaptiveThinking({ id: "claude-opus-50" })).toBe(false);
    expect(supportsClaudeNativeXhighEffort({ id: "claude-opus-4-80" })).toBe(false);
    expect(requiresClaudeDefaultSampling({ id: "claude-opus-4-8" })).toBe(true);
    expect(requiresClaudeDefaultSampling({ id: "claude-mythos-preview" })).toBe(true);
    expect(requiresClaudeDefaultSampling({ id: "claude-opus-4-6" })).toBe(false);
    expect(readLevelIds(resolveClaudeThinkingProfile("claude-opus-4-80"))).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });
});

describe("modelCostsEqual", () => {
  it("matches complete flat rates and rejects missing or stale metadata", () => {
    expect(modelCostsEqual({ ...EXPECTED_COST }, EXPECTED_COST)).toBe(true);
    expect(modelCostsEqual(undefined, EXPECTED_COST)).toBe(false);
    expect(modelCostsEqual({ ...EXPECTED_COST, output: 15 }, EXPECTED_COST)).toBe(false);
  });
});

describe("selectPreferredLocalModelId", () => {
  it("sinks specialist variants below general chat models", () => {
    expect(selectPreferredLocalModelId(["nomic-embed-text", "qwen3.5-vl:7b", "custom-chat"])).toBe(
      "custom-chat",
    );
    expect(selectPreferredLocalModelId(["guard-model", "vision-model"])).toBe("guard-model");
  });

  it("ranks coder variants below general instruct families", () => {
    expect(
      selectPreferredLocalModelId(["qwen3-coder:30b", "meta-llama/Llama-3.3-70B-Instruct"]),
    ).toBe("meta-llama/Llama-3.3-70B-Instruct");
  });

  it("returns undefined for empty input", () => {
    expect(selectPreferredLocalModelId(["", "   "])).toBeUndefined();
  });
});

describe("buildProviderReplayFamilyHooks", () => {
  it("covers the replay family matrix", () => {
    const cases = [
      {
        family: "openai-compatible" as const,
        ctx: {
          provider: "xai",
          modelApi: "openai-completions",
          modelId: "grok-4",
        },
        match: {
          sanitizeToolCallIds: true,
          applyAssistantFirstOrderingFix: true,
          validateGeminiTurns: true,
          dropReasoningFromHistory: true,
        },
        hasSanitizeReplayHistory: false,
        reasoningMode: undefined,
      },
      {
        family: "anthropic-by-model" as const,
        ctx: {
          provider: "anthropic-vertex",
          modelApi: "anthropic-messages",
          modelId: "prod-opus",
          model: {
            params: { canonicalModelId: "claude-opus-5" },
          },
        },
        match: {
          validateAnthropicTurns: true,
        },
        absent: ["dropThinkingBlocks"],
        hasSanitizeReplayHistory: false,
        reasoningMode: undefined,
      },
      {
        family: "native-anthropic-by-model" as const,
        ctx: {
          provider: "anthropic",
          modelApi: "anthropic-messages",
          modelId: "claude-sonnet-4-6",
        },
        match: {
          sanitizeMode: "full",
          preserveNativeAnthropicToolUseIds: true,
          preserveSignatures: true,
          repairToolUseResultPairing: true,
          validateAnthropicTurns: true,
          allowSyntheticToolResults: true,
        },
        absent: ["dropThinkingBlocks"],
        hasSanitizeReplayHistory: false,
        reasoningMode: undefined,
      },
      {
        family: "google-gemini" as const,
        ctx: {
          provider: "google",
          modelApi: "google-generative-ai",
          modelId: "gemini-3.1-pro-preview",
        },
        match: {
          validateGeminiTurns: true,
          allowSyntheticToolResults: true,
        },
        hasSanitizeReplayHistory: true,
        reasoningMode: "tagged",
      },
      {
        family: "passthrough-gemini" as const,
        ctx: {
          provider: "openrouter",
          modelApi: "openai-completions",
          modelId: "gemini-2.5-pro",
        },
        match: {
          applyAssistantFirstOrderingFix: false,
          validateGeminiTurns: false,
          validateAnthropicTurns: false,
          sanitizeThoughtSignatures: {
            allowBase64Only: true,
            includeCamelCase: true,
          },
        },
        hasSanitizeReplayHistory: false,
        reasoningMode: undefined,
      },
      {
        family: "hybrid-anthropic-openai" as const,
        options: {
          anthropicModelDropThinkingBlocks: true,
        },
        ctx: {
          provider: "minimax",
          modelApi: "anthropic-messages",
          modelId: "claude-sonnet-4-6",
        },
        match: {
          validateAnthropicTurns: true,
        },
        absent: ["dropThinkingBlocks"],
        hasSanitizeReplayHistory: false,
        reasoningMode: undefined,
      },
    ];

    for (const testCase of cases) {
      const hooks = buildProviderReplayFamilyHooks(
        testCase.options
          ? {
              family: testCase.family,
              ...testCase.options,
            }
          : { family: testCase.family },
      );

      const policy = hooks.buildReplayPolicy?.(testCase.ctx as never);
      expectFields(policy, testCase.match);
      if ((testCase as { absent?: string[] }).absent) {
        for (const key of (testCase as { absent: string[] }).absent) {
          expect(policy).not.toHaveProperty(key);
        }
      }
      expect(Boolean(hooks.sanitizeReplayHistoryAsync)).toBe(testCase.hasSanitizeReplayHistory);
      expect(hooks.resolveReasoningOutputMode?.(testCase.ctx as never)).toBe(
        testCase.reasoningMode,
      );
    }
  });

  it("exposes canonical replay hooks for reused provider families", () => {
    expectFields(
      buildProviderReplayFamilyHooks({ family: "openai-compatible" }).buildReplayPolicy?.({
        provider: "xai",
        modelApi: "openai-completions",
        modelId: "google/gemma-4-26b-a4b-it",
      } as never),
      {
        sanitizeToolCallIds: true,
        applyAssistantFirstOrderingFix: true,
        validateGeminiTurns: true,
        dropReasoningFromHistory: true,
      },
    );

    const nativeIdsHooks = buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      sanitizeToolCallIds: false,
      dropReasoningFromHistory: false,
    });
    const nativeIdsPolicy = nativeIdsHooks.buildReplayPolicy?.({
      provider: "moonshot",
      modelApi: "openai-completions",
      modelId: "kimi-k2.6",
    } as never);
    expectFields(nativeIdsPolicy, {
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
      validateAnthropicTurns: true,
    });
    expect(nativeIdsPolicy).not.toHaveProperty("sanitizeToolCallIds");
    expect(nativeIdsPolicy).not.toHaveProperty("toolCallIdMode");

    expectFields(
      PASSTHROUGH_GEMINI_REPLAY_HOOKS.buildReplayPolicy?.({
        provider: "openrouter",
        modelApi: "openai-completions",
        modelId: "gemini-2.5-pro",
      } as never),
      {
        applyAssistantFirstOrderingFix: false,
        validateGeminiTurns: false,
        validateAnthropicTurns: false,
        sanitizeThoughtSignatures: {
          allowBase64Only: true,
          includeCamelCase: true,
        },
      },
    );

    expectFields(
      buildProviderReplayFamilyHooks({ family: "anthropic-by-model" }).buildReplayPolicy?.({
        provider: "amazon-bedrock",
        modelApi: "bedrock-converse-stream",
        modelId: "claude-sonnet-4-6",
      } as never),
      {
        validateAnthropicTurns: true,
        repairToolUseResultPairing: true,
      },
    );

    expectFields(
      NATIVE_ANTHROPIC_REPLAY_HOOKS.buildReplayPolicy?.({
        provider: "anthropic",
        modelApi: "anthropic-messages",
        modelId: "claude-sonnet-4-6",
      } as never),
      {
        preserveNativeAnthropicToolUseIds: true,
        preserveSignatures: true,
        validateAnthropicTurns: true,
      },
    );
  });
});
