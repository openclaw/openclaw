import { describe, expect, it, vi } from "vitest";
import { AuthStorage, ModelRegistry } from "../agents/sessions/index.js";
import type { Model } from "../llm/types.js";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
import { summarizeText } from "./tts-core.js";
import type { ResolvedTtsConfig } from "./tts-types.js";

describe("TTS core", () => {
  it("clamps oversized summarization timeout timers", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const model: Model = {
        id: "test-model",
        name: "Test Model",
        api: "test-api",
        provider: "test-provider",
        baseUrl: "https://example.invalid",
        reasoning: false,
        input: ["text"],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: 1024,
        maxTokens: 256,
      };
      const authStorage = AuthStorage.inMemory();
      const modelRegistry = ModelRegistry.inMemory(authStorage);
      const config = {
        auto: "off",
        mode: "final",
        provider: "test-provider",
        providerSource: "config",
        personas: {},
        summaryModel: "test-provider/test-model",
        modelOverrides: {},
        providerConfigs: {},
        maxTextLength: 10_000,
        timeoutMs: 30_000,
      } as ResolvedTtsConfig;

      const result = await summarizeText(
        {
          text: "Long text that should be summarized for speech.",
          targetLength: 120,
          cfg: {},
          config,
          timeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
        },
        {
          completeSimple: vi.fn(async () => ({
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "Short summary." }],
            api: "test-api",
            provider: "test-provider",
            model: "test-model",
            stopReason: "stop" as const,
            usage: {
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
            },
            timestamp: Date.now(),
          })),
          getApiKeyForModel: vi.fn(async () => ({
            apiKey: "key",
            source: "test",
            mode: "api-key" as const,
          })),
          prepareModelForSimpleCompletion: vi.fn(() => model as never),
          requireApiKey: vi.fn(() => "key"),
          resolveModelAsync: vi.fn(async () => ({
            model,
            authStorage,
            modelRegistry,
          })),
        },
      );

      expect(result.summary).toBe("Short summary.");
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});
