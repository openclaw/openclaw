// TTS core tests cover provider selection, synthesis, and error handling.
import { describe, expect, it, vi } from "vitest";
import type { PreparedSimpleCompletionModel } from "../agents/simple-completion-runtime.js";
import type { AssistantMessage, Model, Usage } from "../llm/types.js";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
import type { SpeechModelOverridePolicy } from "./provider-types.js";
import { summarizeText } from "./tts-core.js";
import type { ResolvedTtsConfig } from "./tts-types.js";

const modelOverridePolicy: SpeechModelOverridePolicy = {
  enabled: false,
  allowText: false,
  allowProvider: false,
  allowVoice: false,
  allowModelId: false,
  allowVoiceSettings: false,
  allowNormalization: false,
  allowSeed: false,
};

const usage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

describe("TTS core", () => {
  it("clamps oversized summarization timeout timers", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const model = {
        id: "test-model",
        name: "Test Model",
        api: "test-api",
        provider: "test-provider",
        baseUrl: "https://example.test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 1024,
      } satisfies Model;
      const config = {
        auto: "off",
        mode: "final",
        provider: "test-provider",
        providerSource: "config",
        personas: {},
        summaryModel: "test-provider/test-model",
        modelOverrides: modelOverridePolicy,
        providerConfigs: {},
        maxTextLength: 10_000,
        timeoutMs: 10_000,
      } satisfies ResolvedTtsConfig;
      const auth = {
        apiKey: "key",
        source: "test",
        mode: "api-key",
      } as const;
      const assistant = {
        role: "assistant",
        content: [{ type: "text", text: "Short summary." }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: "stop",
        usage,
        timestamp: Date.now(),
      } satisfies AssistantMessage;

      const result = await summarizeText(
        {
          text: "Long text that should be summarized for speech.",
          targetLength: 120,
          cfg: {},
          config,
          timeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
        },
        {
          completeSimple: vi.fn(async () => assistant),
          prepareSimpleCompletionModel: vi.fn(async () => ({ model, auth })),
          requireApiKey: vi.fn(() => "key"),
        },
      );

      expect(result.summary).toBe("Short summary.");
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("strips reasoning content from summarization output (regression #90364)", async () => {
    const config = {
      provider: "openai",
      model: {
        id: "gpt-5.5",
        api: "openai-completions",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
      },
    } as unknown as ResolvedTtsConfig;
    const testUsage: Usage = {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const auth = { kind: "api-key" as const, apiKey: "test-key" };
    const assistant = {
      role: "assistant" as const,
      content: [
        {
          type: "text",
          text: "<thinking>Internal reasoning that should not be spoken.</thinking>The weather today is sunny with a high of 75°F.",
        },
      ],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-5.5",
      stopReason: "stop",
      usage: testUsage,
      timestamp: Date.now(),
    } satisfies AssistantMessage;

    const result = await summarizeText(
      {
        text: "Long text about the weather that should be summarized for speech.",
        targetLength: 120,
        cfg: {},
        config,
        timeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
      },
      {
        completeSimple: vi.fn(async () => assistant),
        prepareSimpleCompletionModel: vi.fn(
          async () =>
            ({
              model: {
                id: "gpt-5.5",
                api: "openai-completions",
                provider: "openai",
                baseUrl: "https://api.openai.com/v1",
              },
              auth,
            }) as unknown as PreparedSimpleCompletionModel,
        ),
        requireApiKey: vi.fn(() => "key"),
      },
    );

    expect(result.summary).toBe("The weather today is sunny with a high of 75°F.");
    expect(result.summary).not.toContain("<thinking>");
    expect(result.summary).not.toContain("Internal reasoning");
  });

  it("strips multiple reasoning blocks from summarization output", async () => {
    const config = {
      provider: "openai",
      model: {
        id: "gpt-5.5",
        api: "openai-completions",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
      },
    } as unknown as ResolvedTtsConfig;
    const testUsage: Usage = {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const auth = { kind: "api-key" as const, apiKey: "test-key" };

    // Test multiple reasoning blocks
    const assistant = {
      role: "assistant" as const,
      content: [
        {
          type: "text",
          text: "<thinking>First thought.</thinking>Result: <thinking>Second thought.</thinking>Final answer.",
        },
      ],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-5.5",
      stopReason: "stop",
      usage: testUsage,
      timestamp: Date.now(),
    } satisfies AssistantMessage;

    const result = await summarizeText(
      {
        text: "What is the answer?",
        targetLength: 120,
        cfg: {},
        config,
        timeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
      },
      {
        completeSimple: vi.fn(async () => assistant),
        prepareSimpleCompletionModel: vi.fn(
          async () =>
            ({
              model: {
                id: "gpt-5.5",
                api: "openai-completions",
                provider: "openai",
                baseUrl: "https://api.openai.com/v1",
              },
              auth,
            }) as unknown as PreparedSimpleCompletionModel,
        ),
        requireApiKey: vi.fn(() => "key"),
      },
    );

    expect(result.summary).toBe("Result: Final answer.");
    expect(result.summary).not.toContain("<thinking>");
    expect(result.summary).not.toContain("First thought");
    expect(result.summary).not.toContain("Second thought");
  });
});
