import { readFileSync } from "node:fs";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import { resolveSpeechProviderApiKey, summarizeText } from "./tts-core.js";
import { resolveTtsConfig } from "./tts-settings.js";

describe("TTS core", () => {
  it("keeps summarization-only LLM modules lazy", () => {
    const source = readFileSync(new URL("./tts-core.ts", import.meta.url), "utf8");

    expect(source).toContain('import("../agents/simple-completion-runtime.js")');
    expect(source).not.toContain('from "../llm/stream.js"');
    expect(source).not.toContain('from "../agents/simple-completion-runtime.js"');
    expect(source).not.toContain('from "../agents/model-auth.js"');
  });

  it("resolves the first non-blank speech provider API key", () => {
    expect(resolveSpeechProviderApiKey(undefined, " \t", "  provider-key  ", "fallback")).toBe(
      "provider-key",
    );
    expect(resolveSpeechProviderApiKey(undefined, "\n")).toBeUndefined();
  });

  it("clamps oversized summarization timeout timers", async () => {
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
