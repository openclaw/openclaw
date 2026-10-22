/**
 * Regression coverage for transcript replay policy resolution.
 * Exercises provider-family fallbacks and plugin replay hooks.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import {
  shouldAllowProviderOwnedThinkingReplay,
  shouldMergeConsecutiveTurns,
  validateAnthropicTurns,
} from "./embedded-agent-helpers/turns.js";
import type { AgentMessage } from "./runtime/index.js";
import { resolveTranscriptPolicy } from "./transcript-policy.js";

// mock-isolation: Keep synthetic replay policies independent of plugin runtime discovery.
vi.mock("../plugins/provider-hook-runtime.js", async () => {
  const { buildAnthropicReplayPolicyForModel } = await vi.importActual<
    typeof import("../plugins/provider-replay-helpers.js")
  >("../plugins/provider-replay-helpers.js");
  type Context = {
    modelId?: string;
    modelApi?: string;
    env?: NodeJS.ProcessEnv;
    inHistorySystemUpdates?: boolean;
  };
  const anthropic = (context: Context) =>
    buildAnthropicReplayPolicyForModel(
      context.modelId?.toLowerCase() ?? "",
      undefined,
      context.inHistorySystemUpdates,
    );
  const fullReplay = {
    sanitizeMode: "full",
    preserveSignatures: true,
    repairToolUseResultPairing: true,
    validateAnthropicTurns: true,
    allowSyntheticToolResults: true,
  } as const;
  const nullReplay = {
    sanitizeMode: null,
    sanitizeToolCallIds: null,
    toolCallIdMode: null,
    applyAssistantFirstOrderingFix: null,
  };
  type Policy = ReturnType<typeof buildAnthropicReplayPolicyForModel> | typeof nullReplay;
  const policies: Array<[string, (context: Context) => Policy | undefined]> = [
    ["anthropic", anthropic],
    ["amazon-bedrock", anthropic],
    ["ollama", () => undefined],
    [
      "env-sensitive",
      ({ env }) => {
        const mode = env?.OPENCLAW_TEST_TRANSCRIPT_POLICY;
        return mode === "null"
          ? nullReplay
          : {
              sanitizeToolCallIds: mode === "strict",
              applyAssistantFirstOrderingFix: mode === "strict",
              ...(mode === "strict" ? { toolCallIdMode: "strict" } : {}),
            };
      },
    ],
    [
      "minimax",
      (context) =>
        context.modelApi === "openai-completions"
          ? {
              sanitizeToolCallIds: true,
              toolCallIdMode: "strict",
              applyAssistantFirstOrderingFix: true,
              validateGeminiTurns: true,
              validateAnthropicTurns: true,
            }
          : {
              ...fullReplay,
              sanitizeToolCallIds: true,
              toolCallIdMode: "strict",
              ...(anthropic(context).dropThinkingBlocks ? { dropThinkingBlocks: true } : {}),
            },
    ],
    [
      "github-copilot",
      ({ modelApi }) =>
        modelApi === "anthropic-messages" ? { ...fullReplay, dropThinkingBlocks: true } : undefined,
    ],
    ["mistral", () => ({ sanitizeToolCallIds: true, toolCallIdMode: "strict9" })],
  ];
  return {
    resolveProviderRuntimePlugin: vi.fn(({ provider }: { provider?: string }) => {
      if (provider === "vllm") {
        return {};
      }
      const buildReplayPolicy = policies.find(([id]) => id === provider)?.[1];
      return buildReplayPolicy ? { buildReplayPolicy } : undefined;
    }),
  };
});

describe("resolveTranscriptPolicy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function resolve(
    provider: string,
    modelId: string,
    modelApi?: string,
    extra: Partial<Parameters<typeof resolveTranscriptPolicy>[0]> = {},
  ) {
    return resolveTranscriptPolicy({ provider, modelId, modelApi, ...extra });
  }

  function updatingPlugin(provider: string, appendOnlyRuntimeContext?: boolean) {
    return {
      provider,
      plugin: {
        id: provider,
        label: provider,
        auth: [],
        buildReplayPolicy: () => ({
          inHistorySystemUpdates: true,
          ...(appendOnlyRuntimeContext === undefined ? {} : { appendOnlyRuntimeContext }),
        }),
      },
    };
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

  it("resolves replay policy from each supplied environment", () => {
    for (const mode of ["strict", "loose", "null"]) {
      const policy = resolve("env-sensitive", "env-demo", undefined, {
        config: {},
        env: { OPENCLAW_TEST_TRANSCRIPT_POLICY: mode },
      });
      expect(policy).toMatchObject({
        sanitizeMode: "images-only",
        sanitizeToolCallIds: mode === "strict",
        toolCallIdMode: mode === "strict" ? "strict" : undefined,
        applyGoogleTurnOrdering: mode === "strict",
      });
      expect(policy).not.toHaveProperty("applyAssistantFirstOrderingFix");
    }
  });

  it.each([
    [
      "mistral",
      "mistral-large-latest",
      undefined,
      { sanitizeToolCallIds: true, toolCallIdMode: "strict9" },
    ],
    [
      "custom-openai-proxy",
      "qwen3.6-27b",
      "openai-completions",
      { dropReasoningFromHistory: true },
    ],
    ["custom-openai-proxy", "qwen3.6-27b", "openai-responses", { dropReasoningFromHistory: false }],
    [
      "custom-openai-proxy",
      "demo-model",
      "openai-completions",
      {
        sanitizeToolCallIds: true,
        toolCallIdMode: "strict",
        applyGoogleTurnOrdering: true,
        validateGeminiTurns: true,
        validateAnthropicTurns: true,
        appendOnlyRuntimeContext: true,
      },
    ],
    [
      "anthropic-foundry",
      "anthropic-foundry/claude-opus-4-7",
      "openai-responses",
      {
        sanitizeToolCallIds: true,
        toolCallIdMode: "strict",
        validateAnthropicTurns: true,
        validateGeminiTurns: false,
      },
    ],
    ["custom-openai-proxy", "gpt-5.4", "openai-responses", { validateAnthropicTurns: false }],
    ["ollama", "llama3.2", "ollama", { preserveSignatures: false, appendOnlyRuntimeContext: true }],
    [
      "vllm",
      "gemma-3-27b",
      "openai-completions",
      {
        applyGoogleTurnOrdering: true,
        validateGeminiTurns: true,
        validateAnthropicTurns: true,
      },
    ],
  ] as const)("resolves %s/%s replay defaults with %s", (provider, modelId, modelApi, expected) => {
    expect(resolve(provider, modelId, modelApi)).toMatchObject(expected);
  });

  it.each([
    "deepseek-v4-pro",
    "deepseek/deepseek-v4-flash",
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
      expect(
        resolve("custom-openai-proxy", modelId, "openai-completions").dropReasoningFromHistory,
      ).toBe(false);
    },
  );

  it("gates in-history updates by authenticated route", () => {
    const config = {};
    const model = makeOpenAiCompatibleReasoningModel({
      id: "claude-opus-5",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
    });
    for (const [directApiKey, provider, api, baseUrl, expected] of [
      [false, "anthropic", "anthropic-messages", model.baseUrl, false],
      [true, "anthropic", "anthropic-messages", model.baseUrl, true],
      [true, "anthropic", "anthropic-messages", "https://proxy.example.test", false],
      [true, "amazon-bedrock", "bedrock-converse-stream", model.baseUrl, false],
      [true, "google-vertex", "anthropic-messages", model.baseUrl, false],
      [true, "microsoft-foundry", "anthropic-messages", model.baseUrl, false],
    ] as const) {
      const policy = resolveTranscriptPolicy({
        config,
        directApiKey,
        provider,
        modelApi: api,
        modelId: model.id,
        model: { ...model, provider, api, baseUrl },
      });
      expect(policy.inHistorySystemUpdates).toBe(expected);
      expect(policy.appendOnlyRuntimeContext).toBe(expected);
    }
  });

  it("uses the supplied environment for in-history route eligibility", () => {
    const config = {};
    for (const [baseUrl, expected] of [
      ["https://proxy.example.test", false],
      ["https://api.anthropic.com", true],
    ] as const) {
      const policy = resolveTranscriptPolicy({
        config,
        directApiKey: true,
        provider: "anthropic",
        modelApi: "anthropic-messages",
        modelId: "claude-opus-5",
        env: { ANTHROPIC_BASE_URL: baseUrl },
      });
      expect(policy.inHistorySystemUpdates).toBe(expected);
      expect(policy.appendOnlyRuntimeContext).toBe(expected);
    }
  });

  it("limits OpenAI prompt updates to native Responses routes", () => {
    const config = {};
    for (const [provider, api, baseUrl, expected] of [
      ["openai", "openai-responses", "https://api.openai.com/v1", true],
      ["openai", "openai-responses", "https://proxy.example.test/v1", false],
      ["openai", "openai-chatgpt-responses", "https://chatgpt.com/backend-api/codex", false],
      ["openai", "azure-openai-responses", "https://api.openai.com/v1", false],
      ["openai", "openai-completions", "https://api.openai.com/v1", false],
      ["custom-openai", "openai-responses", "https://api.openai.com/v1", false],
    ] as const) {
      const model = makeOpenAiCompatibleReasoningModel({ provider, api, baseUrl });
      const policy = resolveTranscriptPolicy({
        config,
        provider,
        modelApi: api,
        modelId: model.id,
        model,
        runtimeHandle: updatingPlugin(provider),
      });
      expect(policy.inHistorySystemUpdates).toBe(expected);
      expect(policy.appendOnlyRuntimeContext).toBe(api === "openai-completions" || expected);
    }
  });

  it.each([false, true])(
    "constrains explicit plugin updates to host route eligibility (direct API key=%s)",
    (directApiKey) => {
      const policy = resolveTranscriptPolicy({
        directApiKey,
        provider: "anthropic",
        modelApi: "anthropic-messages",
        modelId: "claude-opus-5",
        env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
        runtimeHandle: updatingPlugin("anthropic", false),
      });
      expect(policy.inHistorySystemUpdates).toBe(directApiKey);
      expect(policy.appendOnlyRuntimeContext).toBe(directApiKey);
    },
  );

  it("resolves unowned Anthropic policy from reasoning compatibility", () => {
    const config = {};
    const model = makeOpenAiCompatibleReasoningModel({
      id: "moonshotai/kimi-k2.5",
      name: "Kimi K2.5",
      provider: "qiniu",
      api: "anthropic-messages",
      baseUrl: "https://api.qnaigc.com",
      input: ["text", "image"],
      contextWindow: 256_000,
    });
    for (const supportsReasoningEffort of [undefined, false]) {
      expect(
        resolve(model.provider, model.id, model.api, {
          config,
          model:
            supportsReasoningEffort === undefined
              ? model
              : { ...model, compat: { supportsReasoningEffort } },
        }).dropThinkingBlocks,
      ).toBe(supportsReasoningEffort === false);
    }
  });

  it("resolves OpenAI-compatible reasoning metadata", () => {
    for (const reasoning of [false, true]) {
      const model = makeOpenAiCompatibleReasoningModel({ reasoning });
      expect(
        resolve(model.provider, model.id, model.api, { config: {}, model })
          .dropReasoningFromHistory,
      ).toBe(!reasoning);
    }
  });

  it.each([
    ["claude-fable-5-1", true],
    ["claude-mythos-5-1", false],
    ["claude-fable-5", false],
  ])("scopes persisted context and consecutive-turn merging for %s", (modelId, appendOnly) => {
    const messages: AgentMessage[] = [
      { role: "user", content: "First request", timestamp: 1 },
      { role: "user", content: "Second request", timestamp: 2 },
    ];
    for (const modelApi of ["anthropic-messages", "bedrock-converse-stream"]) {
      for (const provider of ["anthropic", "amazon-bedrock", "custom-proxy"]) {
        const policy = resolveTranscriptPolicy({ provider, modelId, modelApi });
        expect(policy.appendOnlyRuntimeContext).toBe(appendOnly);
        const replay = validateAnthropicTurns(messages, {
          mergeConsecutiveTurns: shouldMergeConsecutiveTurns(policy, modelApi),
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

  it.each([
    ["minimax", "MiniMax-M2.7", "anthropic-messages", true],
    ["amazon-bedrock", "us.anthropic.claude-opus-4-6-v1", "bedrock-converse-stream", true],
    ["github-copilot", "claude-sonnet-4", "anthropic-messages", false],
    ["vllm", "gemma-3-27b", "openai-completions", false],
  ] as const)(
    "resolves immutable thinking replay for %s",
    (provider, modelId, modelApi, expected) => {
      const policy = resolve(provider, modelId, modelApi);
      expect(shouldAllowProviderOwnedThinkingReplay({ modelApi, policy })).toBe(expected);
    },
  );

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
});
