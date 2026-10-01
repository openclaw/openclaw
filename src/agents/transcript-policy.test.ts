/**
 * Regression coverage for transcript replay policy resolution.
 * Exercises provider-family fallbacks, plugin replay hooks, and policy caching.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import {
  shouldAllowProviderOwnedThinkingReplay,
  shouldMergeConsecutiveUserTurns,
  validateAnthropicTurns,
} from "./embedded-agent-helpers/turns.js";
import type { AgentMessage } from "./runtime/index.js";

vi.mock("../plugins/provider-hook-runtime.js", async () => {
  const replayHelpers = await vi.importActual<
    typeof import("../plugins/provider-replay-helpers.js")
  >("../plugins/provider-replay-helpers.js");
  return {
    resolveProviderRuntimePlugin: vi.fn(({ provider }: { provider?: string }) => {
      if (
        !provider ||
        ![
          "amazon-bedrock",
          "anthropic",
          "google",
          "github-copilot",
          "env-sensitive",
          "minimax",
          "mistral",
          "openai",
          "ollama",
          "vllm",
        ].includes(provider)
      ) {
        return undefined;
      }
      if (provider === "vllm") {
        return {};
      }
      return {
        buildReplayPolicy: (context?: {
          modelId?: string;
          modelApi?: string;
          env?: NodeJS.ProcessEnv;
        }) => {
          const modelId = context?.modelId?.toLowerCase() ?? "";
          switch (provider) {
            case "env-sensitive":
              return {
                sanitizeToolCallIds: context?.env?.OPENCLAW_TEST_TRANSCRIPT_POLICY === "strict",
                ...(context?.env?.OPENCLAW_TEST_TRANSCRIPT_POLICY === "strict"
                  ? { toolCallIdMode: "strict" as const }
                  : {}),
              };
            case "amazon-bedrock":
            case "anthropic":
              return replayHelpers.buildAnthropicReplayPolicyForModel(modelId);
            case "minimax":
              return context?.modelApi === "openai-completions"
                ? {
                    sanitizeToolCallIds: true,
                    toolCallIdMode: "strict",
                    applyAssistantFirstOrderingFix: true,
                    validateGeminiTurns: true,
                    validateAnthropicTurns: true,
                  }
                : {
                    sanitizeMode: "full",
                    sanitizeToolCallIds: true,
                    toolCallIdMode: "strict",
                    preserveSignatures: true,
                    repairToolUseResultPairing: true,
                    validateAnthropicTurns: true,
                    allowSyntheticToolResults: true,
                    ...(replayHelpers.shouldDropClaudeThinkingBlocks(modelId)
                      ? { dropThinkingBlocks: true }
                      : {}),
                  };
            case "google":
              return {
                sanitizeMode: "full",
                sanitizeToolCallIds: true,
                toolCallIdMode: "strict",
                sanitizeThoughtSignatures: {
                  allowBase64Only: true,
                  includeCamelCase: true,
                },
                repairToolUseResultPairing: true,
                applyAssistantFirstOrderingFix: true,
                validateGeminiTurns: true,
                validateAnthropicTurns: false,
                allowSyntheticToolResults: true,
              };
            case "github-copilot":
              return context?.modelApi === "anthropic-messages"
                ? {
                    sanitizeMode: "full",
                    preserveSignatures: true,
                    repairToolUseResultPairing: true,
                    validateAnthropicTurns: true,
                    allowSyntheticToolResults: true,
                    dropThinkingBlocks: true,
                  }
                : undefined;
            case "mistral":
              return {
                sanitizeToolCallIds: true,
                toolCallIdMode: "strict9",
              };
            case "openai":
              return {
                sanitizeMode: "images-only",
                sanitizeToolCallIds: context?.modelApi === "openai-completions",
                ...(context?.modelApi === "openai-completions" ? { toolCallIdMode: "strict" } : {}),
                applyAssistantFirstOrderingFix: false,
                validateGeminiTurns: false,
                validateAnthropicTurns: false,
              };
            default:
              return undefined;
          }
        },
      };
    }),
  };
});

let resolveTranscriptPolicy: typeof import("./transcript-policy.js").resolveTranscriptPolicy;
describe("resolveTranscriptPolicy", () => {
  beforeAll(async () => {
    ({ resolveTranscriptPolicy } = await import("./transcript-policy.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function expectStrictOpenAiCompatibleReplayDefaults(provider: string): void {
    const policy = resolveTranscriptPolicy({
      provider,
      modelId: "demo-model",
      modelApi: "openai-completions",
    });

    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.toolCallIdMode).toBe("strict");
    expect(policy.applyGoogleTurnOrdering).toBe(true);
    expect(policy.validateGeminiTurns).toBe(true);
    expect(policy.validateAnthropicTurns).toBe(true);
  }

  function makeOpenAiCompatibleReasoningModel(
    overrides: Partial<ProviderRuntimeModel> = {},
  ): ProviderRuntimeModel {
    return {
      id: "qwen3.6-27b",
      name: "Qwen3.6 27B",
      provider: "custom-openai-proxy",
      api: "openai-completions",
      baseUrl: "https://example.invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
      ...overrides,
    };
  }

  it("memoizes replay policy resolution for the same config and process env", () => {
    const config = {} as OpenClawConfig;

    const firstPolicy = resolveTranscriptPolicy({
      provider: "mistral",
      modelId: "mistral-large-latest",
      config,
      env: process.env,
    });
    const secondPolicy = resolveTranscriptPolicy({
      provider: "mistral",
      modelId: "mistral-large-latest",
      config,
      env: process.env,
    });

    expect(secondPolicy).toBe(firstPolicy);
  });

  it("does not reuse cached replay policies across custom env objects", () => {
    const config = {} as OpenClawConfig;
    const strictEnv = {
      ...process.env,
      OPENCLAW_TEST_TRANSCRIPT_POLICY: "strict",
    };
    const looseEnv = {
      ...process.env,
      OPENCLAW_TEST_TRANSCRIPT_POLICY: "loose",
    };

    const strictPolicy = resolveTranscriptPolicy({
      provider: "env-sensitive",
      modelId: "env-demo",
      config,
      env: strictEnv,
    });
    const loosePolicy = resolveTranscriptPolicy({
      provider: "env-sensitive",
      modelId: "env-demo",
      config,
      env: looseEnv,
    });

    expect(strictPolicy.sanitizeToolCallIds).toBe(true);
    expect(strictPolicy.toolCallIdMode).toBe("strict");
    expect(loosePolicy.sanitizeToolCallIds).toBe(false);
    expect(loosePolicy.toolCallIdMode).toBeUndefined();
  });

  it("enables sanitizeToolCallIds for Google provider", () => {
    const policy = resolveTranscriptPolicy({
      provider: "google",
      modelId: "gemini-2.0-flash",
      modelApi: "google-generative-ai",
    });
    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.sanitizeThoughtSignatures).toEqual({
      allowBase64Only: true,
      includeCamelCase: true,
    });
  });

  it("enables sanitizeToolCallIds for Mistral provider", () => {
    const policy = resolveTranscriptPolicy({
      provider: "mistral",
      modelId: "mistral-large-latest",
    });
    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.toolCallIdMode).toBe("strict9");
  });

  it("disables sanitizeToolCallIds for OpenAI provider", () => {
    const policy = resolveTranscriptPolicy({
      provider: "openai",
      modelId: "gpt-4o",
      modelApi: "openai",
    });
    expect(policy.sanitizeToolCallIds).toBe(false);
    expect(policy.toolCallIdMode).toBeUndefined();
    expect(policy.applyGoogleTurnOrdering).toBe(false);
    expect(policy.validateGeminiTurns).toBe(false);
    expect(policy.validateAnthropicTurns).toBe(false);
  });

  it("strips historical reasoning for strict OpenAI-compatible providers by default", () => {
    const policy = resolveTranscriptPolicy({
      provider: "custom-openai-proxy",
      modelId: "qwen3.6-27b",
      modelApi: "openai-completions",
    });
    expect(policy.dropReasoningFromHistory).toBe(true);

    const responsesPolicy = resolveTranscriptPolicy({
      provider: "custom-openai-proxy",
      modelId: "qwen3.6-27b",
      modelApi: "openai-responses",
    });
    expect(responsesPolicy.dropReasoningFromHistory).toBe(false);
  });

  it.each([
    "kimi-for-coding",
    "moonshotai/kimi-k2.6",
    "moonshot/kimi-k2.7-code",
    "moonshot/kimi-k2.7-code-highspeed",
    "moonshot/kimi-k3",
    "kimi-k2-thinking",
    "hf:moonshotai/kimi-k2-thinking",
    "xiaomi/mimo-v2.6-flash",
    "xiaomi/mimo-v2.6-pro",
    "xiaomi/mimo-v2.6-pro-ultraspeed",
    "xiaomi/mimo-v2.6-pro:cloud",
  ])(
    "preserves historical reasoning for %s replay-required OpenAI-compatible models",
    (modelId) => {
      const policy = resolveTranscriptPolicy({
        provider: "custom-openai-proxy",
        modelId,
        modelApi: "openai-completions",
      });

      expect(policy.dropReasoningFromHistory).toBe(false);
    },
  );

  it("falls back to unowned transport defaults when no owning plugin exists", () => {
    expectStrictOpenAiCompatibleReplayDefaults("custom-openai-proxy");
  });

  it("enables assistant prefill stripping for unowned Claude OpenAI Responses routes (#79688)", () => {
    const claudePolicy = resolveTranscriptPolicy({
      provider: "anthropic-foundry",
      modelId: "anthropic-foundry/claude-opus-4-7",
      modelApi: "openai-responses",
    });
    expect(claudePolicy.sanitizeToolCallIds).toBe(true);
    expect(claudePolicy.toolCallIdMode).toBe("strict");
    expect(claudePolicy.validateAnthropicTurns).toBe(true);
    expect(claudePolicy.validateGeminiTurns).toBe(false);

    const gptPolicy = resolveTranscriptPolicy({
      provider: "custom-openai-proxy",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
    });
    expect(gptPolicy.validateAnthropicTurns).toBe(false);
  });

  it("preserves thinking blocks for newer Claude models in unowned Anthropic transport fallback", () => {
    const opus46 = resolveTranscriptPolicy({
      provider: "custom-anthropic-proxy",
      modelId: "claude-opus-4-6",
      modelApi: "anthropic-messages",
    });
    expect(opus46.dropThinkingBlocks).toBe(false);

    const opus5 = resolveTranscriptPolicy({
      provider: "custom-anthropic-proxy",
      modelId: "claude-opus-5",
      modelApi: "anthropic-messages",
    });
    expect(opus5.dropThinkingBlocks).toBe(false);

    const sonnet45 = resolveTranscriptPolicy({
      provider: "custom-anthropic-proxy",
      modelId: "claude-sonnet-4-5-20250929",
      modelApi: "anthropic-messages",
    });
    expect(sonnet45.dropThinkingBlocks).toBe(true);

    const sonnet37 = resolveTranscriptPolicy({
      provider: "custom-anthropic-proxy",
      modelId: "claude-3-7-sonnet-20250219",
      modelApi: "anthropic-messages",
    });
    expect(sonnet37.dropThinkingBlocks).toBe(true);
  });

  it("does not reuse cached Anthropic policies across canonical model identities", () => {
    const config = {} as OpenClawConfig;
    const model = makeOpenAiCompatibleReasoningModel({
      id: "production-claude",
      name: "Production Claude",
      provider: "custom-anthropic-proxy",
      api: "anthropic-messages",
    });

    const sonnet45 = resolveTranscriptPolicy({
      config,
      provider: "custom-anthropic-proxy",
      modelId: model.id,
      modelApi: model.api,
      model: {
        ...model,
        params: { canonicalModelId: "claude-sonnet-4-5-20250929" },
      },
    });
    const opus5 = resolveTranscriptPolicy({
      config,
      provider: "custom-anthropic-proxy",
      modelId: model.id,
      modelApi: model.api,
      model: {
        ...model,
        params: { canonicalModelId: "claude-opus-5" },
      },
    });

    expect(sonnet45.dropThinkingBlocks).toBe(true);
    expect(opus5.dropThinkingBlocks).toBe(false);
  });

  it("does not reuse cached unowned Anthropic policies across reasoning compat changes", () => {
    const config = {} as OpenClawConfig;
    const model = {
      id: "moonshotai/kimi-k2.5",
      name: "Kimi K2.5",
      provider: "qiniu",
      api: "anthropic-messages" as const,
      baseUrl: "https://api.qnaigc.com",
      reasoning: false,
      input: ["text" as const, "image" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 256_000,
      maxTokens: 16_384,
    };

    const defaultPolicy = resolveTranscriptPolicy({
      config,
      provider: "qiniu",
      modelId: "moonshotai/kimi-k2.5",
      modelApi: "anthropic-messages",
      model,
    });
    const noReasoningPolicy = resolveTranscriptPolicy({
      config,
      provider: "qiniu",
      modelId: "moonshotai/kimi-k2.5",
      modelApi: "anthropic-messages",
      model: { ...model, compat: { supportsReasoningEffort: false } },
    });

    expect(defaultPolicy.dropThinkingBlocks).toBe(false);
    expect(noReasoningPolicy.dropThinkingBlocks).toBe(true);
  });

  it("does not reuse cached OpenAI-compatible policies across reasoning metadata changes", () => {
    const config = {} as OpenClawConfig;

    const defaultPolicy = resolveTranscriptPolicy({
      config,
      provider: "custom-openai-proxy",
      modelId: "qwen3.6-27b",
      modelApi: "openai-completions",
      model: makeOpenAiCompatibleReasoningModel(),
    });
    const reasoningPolicy = resolveTranscriptPolicy({
      config,
      provider: "custom-openai-proxy",
      modelId: "qwen3.6-27b",
      modelApi: "openai-completions",
      model: makeOpenAiCompatibleReasoningModel({ reasoning: true }),
    });

    expect(defaultPolicy.dropReasoningFromHistory).toBe(true);
    expect(reasoningPolicy.dropReasoningFromHistory).toBe(false);
  });

  it("enables Anthropic-compatible policies for Bedrock provider", () => {
    const policy = resolveTranscriptPolicy({
      provider: "amazon-bedrock",
      modelId: "us.anthropic.claude-opus-4-6-v1",
      modelApi: "bedrock-converse-stream",
    });
    expect(policy.repairToolUseResultPairing).toBe(true);
    expect(policy.validateAnthropicTurns).toBe(true);
    expect(policy.allowSyntheticToolResults).toBe(true);
    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.sanitizeMode).toBe("full");
  });

  it("keeps core replay defaults when an owning plugin returns no policy", () => {
    const policy = resolveTranscriptPolicy({
      provider: "ollama",
      modelId: "llama3.2",
      modelApi: "ollama",
    });
    expect(policy.preserveSignatures).toBe(false);
    expect(policy.appendOnlyRuntimeContext).toBe(false);
  });

  it.each([
    ["claude-fable-5-1", true],
    ["claude-mythos-5-1", false],
    ["claude-fable-5", false],
  ])("scopes persisted context and user-turn merging for %s", (modelId, appendOnly) => {
    const messages: AgentMessage[] = [
      { role: "user", content: "First request", timestamp: 1 },
      { role: "user", content: "Second request", timestamp: 2 },
    ];
    for (const modelApi of ["anthropic-messages", "bedrock-converse-stream"]) {
      for (const provider of ["anthropic", "amazon-bedrock", "custom-proxy"]) {
        const policy = resolveTranscriptPolicy({ provider, modelId, modelApi });
        expect(policy.appendOnlyRuntimeContext).toBe(appendOnly);
        const replay = validateAnthropicTurns(messages, {
          mergeConsecutiveUserTurns: shouldMergeConsecutiveUserTurns(policy, modelApi),
        });
        expect(replay).toEqual(
          appendOnly && modelApi === "anthropic-messages"
            ? messages
            : [
                {
                  role: "user",
                  content: [
                    { type: "text", text: "First request" },
                    { type: "text", text: "Second request" },
                  ],
                  timestamp: 2,
                },
              ],
        );
      }
    }
  });

  it.each(["claude-fable-5-1", "claude-mythos-5-1"])(
    "uses canonical deployment identity for unowned %s replay",
    (canonicalModelId) => {
      const policy = resolveTranscriptPolicy({
        provider: "microsoft-foundry",
        modelApi: "anthropic-messages",
        modelId: "deployment",
        model: makeOpenAiCompatibleReasoningModel({ params: { canonicalModelId } }),
      });
      expect(policy.appendOnlyRuntimeContext).toBe(canonicalModelId === "claude-fable-5-1");
    },
  );

  it("allows immutable provider-owned thinking replay for anthropic-compatible native replay policies", () => {
    const policy = resolveTranscriptPolicy({
      provider: "minimax",
      modelId: "MiniMax-M2.7",
      modelApi: "anthropic-messages",
    });
    expect(
      shouldAllowProviderOwnedThinkingReplay({
        modelApi: "anthropic-messages",
        policy,
      }),
    ).toBe(true);
  });

  it("allows immutable provider-owned thinking replay for bedrock claude replay policies", () => {
    const policy = resolveTranscriptPolicy({
      provider: "amazon-bedrock",
      modelId: "us.anthropic.claude-opus-4-6-v1",
      modelApi: "bedrock-converse-stream",
    });
    expect(
      shouldAllowProviderOwnedThinkingReplay({
        modelApi: "bedrock-converse-stream",
        policy,
      }),
    ).toBe(true);
  });

  it.each(["anthropic", "amazon-bedrock"] as const)(
    "allows provider-owned thinking replay for signed-thinking %s recovery policies",
    (provider) => {
      expect(
        shouldAllowProviderOwnedThinkingReplay({
          provider,
          modelApi:
            provider === "amazon-bedrock" ? "bedrock-converse-stream" : "anthropic-messages",
          policy: {
            validateAnthropicTurns: true,
            preserveSignatures: false,
            dropThinkingBlocks: false,
          },
        }),
      ).toBe(true);
    },
  );

  it("does not allow immutable provider-owned thinking replay for github-copilot claude models", () => {
    const policy = resolveTranscriptPolicy({
      provider: "github-copilot",
      modelId: "claude-sonnet-4",
      modelApi: "anthropic-messages",
    });
    expect(
      shouldAllowProviderOwnedThinkingReplay({
        modelApi: "anthropic-messages",
        policy,
      }),
    ).toBe(false);
  });

  it("does not allow immutable provider-owned thinking replay for strict openai-compatible replay", () => {
    const policy = resolveTranscriptPolicy({
      provider: "vllm",
      modelId: "gemma-3-27b",
      modelApi: "openai-completions",
    });
    expect(
      shouldAllowProviderOwnedThinkingReplay({
        modelApi: "openai-completions",
        policy,
      }),
    ).toBe(false);
  });

  it("enables turn-ordering and assistant-merge for strict OpenAI-compatible providers (#38962)", () => {
    const policy = resolveTranscriptPolicy({
      provider: "vllm",
      modelId: "gemma-3-27b",
      modelApi: "openai-completions",
    });
    expect(policy.applyGoogleTurnOrdering).toBe(true);
    expect(policy.validateGeminiTurns).toBe(true);
    expect(policy.validateAnthropicTurns).toBe(true);
  });
});
