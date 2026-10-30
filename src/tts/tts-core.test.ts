import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import { resolveTtsConfig } from "./tts-settings.js";

describe("TTS core", () => {
  it("resolves speech provider keys without loading summarization-only LLM modules", async () => {
    vi.resetModules();
    // mock-isolation: Cold speech imports must not load the summary completion runtime.
    vi.doMock("../agents/simple-completion-runtime.js", () => {
      throw new Error("Cold speech import loaded the summary completion runtime");
    });
    // mock-isolation: Cold speech imports must not load the summary credential runtime.
    vi.doMock("../agents/model-auth.js", () => {
      throw new Error("Cold speech import loaded the summary credential runtime");
    });
    // mock-isolation: Cold speech imports must not load the LLM streaming runtime.
    vi.doMock("../llm/stream.js", () => {
      throw new Error("Cold speech import loaded the LLM streaming runtime");
    });
    try {
      const { resolveSpeechProviderApiKey } = await import("./tts-core.js");
      expect(resolveSpeechProviderApiKey(undefined, " \t", "  provider-key  ", "fallback")).toBe(
        "provider-key",
      );
      expect(resolveSpeechProviderApiKey(undefined, "\n")).toBeUndefined();
    } finally {
      vi.doUnmock("../agents/simple-completion-runtime.js");
      vi.doUnmock("../agents/model-auth.js");
      vi.doUnmock("../llm/stream.js");
      vi.resetModules();
    }
  });

  it("clamps oversized summarization timeout timers", async () => {
    const { summarizeText } = await import("./tts-core.js");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const model = makeProviderModelFixture({
        id: "test-model",
        api: "test-api",
        provider: "test-provider",
        baseUrl: "https://example.test",
      });
      const config = resolveTtsConfig({ tts: { summaryModel: "test-provider/test-model" } });
      const auth = {
        apiKey: "key",
        source: "test",
        mode: "api-key",
      } as const;
      const assistant = makeAgentAssistantMessage({
        content: [{ type: "text", text: "Short summary." }],
        api: model.api,
        provider: model.provider,
        model: model.id,
      });

      const result = await summarizeText(
        {
          text: "Long text that should be summarized for speech.",
          targetLength: 120,
          cfg: {},
          config,
          timeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
        },
        {
          completeWithPreparedSimpleCompletionModel: vi.fn(async () => assistant),
          prepareSimpleCompletionModel: vi.fn(async () => ({
            model,
            auth,
            async [Symbol.asyncDispose]() {},
          })),
          requireApiKey: vi.fn(() => "key"),
        },
      );

      expect(result.summary).toBe("Short summary.");
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});
