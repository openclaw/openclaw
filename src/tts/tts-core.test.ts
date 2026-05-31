import { describe, expect, it, vi } from "vitest";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
import { summarizeText } from "./tts-core.js";
import type { ResolvedTtsConfig } from "./tts-types.js";

describe("TTS core", () => {
  it("clamps oversized summarization timeout timers", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const model = { provider: { id: "test-provider" } };
      const config = {
        summarizeModel: { primary: "test-provider/test-model" },
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
            content: [{ type: "text", text: "Short summary." }],
            stopReason: "stop",
            usage: {},
          })),
          getApiKeyForModel: vi.fn(async () => "key"),
          prepareModelForSimpleCompletion: vi.fn(() => model as never),
          requireApiKey: vi.fn(() => "key"),
          resolveModelAsync: vi.fn(async () => ({ model })),
        },
      );

      expect(result.summary).toBe("Short summary.");
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});
