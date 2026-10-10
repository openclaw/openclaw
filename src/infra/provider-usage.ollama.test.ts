import { describe, expect, it, vi } from "vitest";
import { loadProviderUsageSummary } from "./provider-usage.load.js";

describe("Ollama provider usage integration", () => {
  const configFor = (baseUrl: string, apiKey: string) => ({
    models: {
      providers: {
        ollama: {
          baseUrl,
          api: "ollama" as const,
          apiKey,
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
  });

  it("loads balance through the configured local provider", async () => {
    const summary = await loadProviderUsageSummary({
      providers: ["ollama"],
      config: configFor("http://127.0.0.1:11434/v1", "ollama-local"),
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

  it.each([
    ["ollama-local", { Accept: "application/json" }],
    ["endpoint-key", { Accept: "application/json", Authorization: "Bearer endpoint-key" }],
  ])("keeps ambient Cloud auth off LAN requests with %s", async (apiKey, headers) => {
    const fetchFn = vi.fn(async () =>
      Response.json({ included: { session: { remaining_percent: 80 } } }),
    );
    const summary = await loadProviderUsageSummary({
      providers: ["ollama"],
      config: configFor("http://10.0.0.5:11434", apiKey),
      env: { OLLAMA_API_KEY: "ambient-cloud-key" },
      fetch: fetchFn,
      timeoutMs: 5000,
    });
    expect(summary.providers[0]?.error).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledExactlyOnceWith(
      "http://10.0.0.5:11434/api/balance",
      expect.objectContaining({ headers }),
    );
  });
});
