import { describe, expect, it, vi } from "vitest";
import { loadProviderUsageSummary } from "./provider-usage.load.js";

describe("Ollama provider usage integration", () => {
  it("loads balance through the configured local provider", async () => {
    const config = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434/v1",
            api: "ollama" as const,
            apiKey: "ollama-local",
            models: [
              {
                id: "test",
                name: "Test",
                reasoning: false,
                input: ["text" as const],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8192,
                maxTokens: 1024,
              },
            ],
          },
        },
      },
      plugins: { allow: ["ollama"], entries: { ollama: { enabled: true } } },
    };
    const summary = await loadProviderUsageSummary({
      providers: ["ollama"],
      config,
      env: {},
      fetch: vi.fn(async () => Response.json({ included: { session: { remaining_percent: 80 } } })),
      timeoutMs: 5000,
    });
    expect(summary.providers).toEqual([
      expect.objectContaining({
        provider: "ollama",
        windows: [{ label: "Session", usedPercent: 20 }],
      }),
    ]);
  });
});
