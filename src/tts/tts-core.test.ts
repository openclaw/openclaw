import { describe, expect, it, vi } from "vitest";
import type { ResolvedProviderAuth } from "../agents/model-auth-runtime-shared.js";
import type { AssistantMessage, Model } from "../llm/types.js";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
import { summarizeText } from "./tts-core.js";
import type { ResolvedTtsConfig } from "./tts-types.js";

describe("TTS core", () => {
  it("clamps oversized summarization timeout timers", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const model = {
        api: "openai-responses",
        provider: { id: "test-provider", name: "Test Provider" },
        id: "test-model",
        name: "Test Model",
      } as unknown as Model;
      const config = {
        summaryModel: "test-provider/test-model",
      } as unknown as ResolvedTtsConfig;
      const auth: ResolvedProviderAuth = {
        apiKey: "key",
        mode: "api-key",
        source: "test",
      };

      const result = await summarizeText(
        {
          text: "Long text that should be summarized for speech.",
          targetLength: 120,
          cfg: {},
          config,
          timeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
        },
        {
          completeSimple: vi.fn(
            async () =>
              ({
                role: "assistant",
                content: [{ type: "text", text: "Short summary." }],
                api: "openai-responses",
                provider: model.provider,
                model: model.id,
                stopReason: "stop",
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
              }) satisfies AssistantMessage,
          ),
          getApiKeyForModel: vi.fn(async () => auth),
          prepareModelForSimpleCompletion: vi.fn(({ model: preparedModel }) => preparedModel),
          requireApiKey: vi.fn(() => "key"),
          resolveModelAsync: vi.fn(async () => ({
            authStorage: {} as never,
            model,
            modelRegistry: {} as never,
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
