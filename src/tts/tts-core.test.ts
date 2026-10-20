import { readFileSync } from "node:fs";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import { createZeroUsage } from "../../packages/ai/src/usage.test-support.js";
import type { AssistantMessage, Model } from "../llm/types.js";
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
      const config = resolveTtsConfig({ tts: { summaryModel: "test-provider/test-model" } });
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
        usage: createZeroUsage(),
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
