import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderCapabilitiesWithPlugin: vi.fn(({ provider }: { provider?: string }) => {
    switch (provider) {
      case "kimi":
      case "kimi-code":
        return {
          providerFamily: "anthropic",
          preserveAnthropicThinkingSignatures: false,
        };
      case "openrouter":
        return {
          openAiCompatTurnValidation: false,
          geminiThoughtSignatureSanitization: true,
          geminiThoughtSignatureModelHints: ["gemini"],
        };
      case "kilocode":
        return {
          geminiThoughtSignatureSanitization: true,
          geminiThoughtSignatureModelHints: ["gemini"],
        };
      default:
        return undefined;
    }
  }),
  resolveProviderReplayPolicyWithPlugin: vi.fn(() => undefined),
  resetProviderRuntimeHookCacheForTest: vi.fn(),
}));

let resolveTranscriptPolicy: typeof import("./transcript-policy.js").resolveTranscriptPolicy;

describe("resolveTranscriptPolicy", () => {
  beforeAll(async () => {
    ({ resolveTranscriptPolicy } = await import("./transcript-policy.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enables sanitizeToolCallIds for Anthropic provider", () => {
    const policy = resolveTranscriptPolicy({
      provider: "anthropic",
      modelId: "claude-opus-4-5",
      modelApi: "anthropic-messages",
    });
    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.toolCallIdMode).toBe("strict");
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
  });

  it("enables strict tool call id sanitization for openai-completions APIs", () => {
    const policy = resolveTranscriptPolicy({
      provider: "openai",
      modelId: "gpt-5.2",
      modelApi: "openai-completions",
    });
    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.toolCallIdMode).toBe("strict");
  });

  it("enables user-turn merge for strict OpenAI-compatible providers", () => {
    const policy = resolveTranscriptPolicy({
      provider: "moonshot",
      modelId: "kimi-k2.5",
      modelApi: "openai-completions",
    });
    expect(policy.applyGoogleTurnOrdering).toBe(true);
    expect(policy.validateGeminiTurns).toBe(true);
    expect(policy.validateAnthropicTurns).toBe(true);
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

  it.each([
    {
      title: "Anthropic provider",
      provider: "anthropic",
      modelId: "claude-opus-4-5",
      modelApi: "anthropic-messages" as const,
      preserveSignatures: true,
    },
    {
      title: "Bedrock Anthropic",
      provider: "amazon-bedrock",
      modelId: "us.anthropic.claude-opus-4-6-v1",
      modelApi: "bedrock-converse-stream" as const,
      preserveSignatures: true,
    },
    {
      title: "Google provider",
      provider: "google",
      modelId: "gemini-2.0-flash",
      modelApi: "google-generative-ai" as const,
      preserveSignatures: false,
    },
    {
      title: "OpenAI provider",
      provider: "openai",
      modelId: "gpt-4o",
      modelApi: "openai" as const,
      preserveSignatures: false,
    },
    {
      title: "Mistral provider",
      provider: "mistral",
      modelId: "mistral-large-latest",
      preserveSignatures: false,
    },
    {
      title: "Kimi provider",
      provider: "kimi",
      modelId: "kimi-code",
      modelApi: "anthropic-messages" as const,
      preserveSignatures: false,
    },
    {
      title: "kimi-code alias",
      provider: "kimi-code",
      modelId: "kimi-code",
      modelApi: "anthropic-messages" as const,
      preserveSignatures: false,
    },
  ])("sets preserveSignatures for $title (#32526, #39798)", ({ preserveSignatures, ...input }) => {
    const policy = resolveTranscriptPolicy(input);
    expect(policy.preserveSignatures).toBe(preserveSignatures);
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

  it("keeps OpenRouter on its existing turn-validation path", () => {
    const policy = resolveTranscriptPolicy({
      provider: "openrouter",
      modelId: "openai/gpt-4.1",
      modelApi: "openai-completions",
    });
    expect(policy.applyGoogleTurnOrdering).toBe(false);
    expect(policy.validateGeminiTurns).toBe(false);
    expect(policy.validateAnthropicTurns).toBe(false);
  });

  it.each([
    { provider: "openrouter", modelId: "google/gemini-2.5-pro-preview" },
    { provider: "opencode", modelId: "google/gemini-2.5-flash" },
    { provider: "kilocode", modelId: "gemini-2.0-flash" },
  ])("sanitizes Gemini thought signatures for $provider routes", ({ provider, modelId }) => {
    const policy = resolveTranscriptPolicy({
      provider,
      modelId,
      modelApi: "openai-completions",
    });
    expect(policy.sanitizeThoughtSignatures).toEqual({
      allowBase64Only: true,
      includeCamelCase: true,
    });
  });
});
