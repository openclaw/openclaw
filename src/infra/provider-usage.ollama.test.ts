import { describe, expect, it, vi } from "vitest";
import { loadProviderUsageSummary } from "./provider-usage.load.js";

describe("Ollama provider usage integration", () => {
  const configFor = (baseUrl: string, apiKey?: string) => ({
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
  const hostedOnlyConfig = () => {
    const config = configFor("https://ollama.com", "hosted-key");
    return {
      ...config,
      models: { providers: { "ollama-cloud": config.models.providers.ollama } },
    };
  };

  it("loads balance through the configured local provider", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({ included: { session: { remaining_percent: 80 } } }),
    );
    const summary = await loadProviderUsageSummary({
      providers: ["ollama"],
      config: configFor("http://127.0.0.1:11434/v1", "ollama-local"),
      env: {},
      fetch: fetchFn,
      timeoutMs: 5000,
    });
    expect(summary.providers).toEqual([
      expect.objectContaining({
        provider: "ollama",
        windows: [{ label: "Session", usedPercent: 20 }],
      }),
    ]);
    expect(fetchFn).toHaveBeenCalledExactlyOnceWith(
      "http://127.0.0.1:11434/api/balance",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it.each([401, 404])("omits unavailable Cloud balance for HTTP %i", async (status) => {
    const fetchFn = vi.fn(async () => new Response("private", { status }));
    const summary = await loadProviderUsageSummary({
      providers: ["ollama"],
      config: configFor("http://127.0.0.1:11434", "ollama-local"),
      env: {},
      fetch: fetchFn,
    });
    expect(summary.providers).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["ollama-local", { Accept: "application/json" }],
    ["OLLAMA_API_KEY", { Accept: "application/json" }],
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

  it("does not query a local daemon for hosted-only credentials", async () => {
    const fetchFn = vi.fn();
    const summary = await loadProviderUsageSummary({
      providers: ["ollama"],
      config: hostedOnlyConfig(),
      env: {},
      fetch: fetchFn,
      timeoutMs: 5000,
    });
    expect(summary.providers).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, {}],
    [undefined, { OLLAMA_API_KEY: "ambient-cloud-key" }],
    ["OLLAMA_API_KEY", {}],
    ["OLLAMA_API_KEY", { OLLAMA_API_KEY: "ambient-cloud-key" }],
    ["ollama-local", {}],
    ["ollama-local", { OLLAMA_API_KEY: "ambient-cloud-key" }],
  ])("uses stored endpoint credentials with local key %s and env %j", async (apiKey, env) => {
    const fetchFn = vi.fn(async () =>
      Response.json({ included: { session: { remaining_percent: 80 } } }),
    );
    const summary = await loadProviderUsageSummary({
      providers: ["ollama"],
      config: configFor("http://10.0.0.5:11434", apiKey),
      authStore: {
        version: 1,
        profiles: {
          "ollama:endpoint": { type: "api_key", provider: "ollama", key: "endpoint-key" },
        },
      },
      env,
      fetch: fetchFn,
    });
    expect(summary.providers[0]?.windows).toEqual([{ label: "Session", usedPercent: 20 }]);
    expect(fetchFn).toHaveBeenCalledExactlyOnceWith(
      "http://10.0.0.5:11434/api/balance",
      expect.objectContaining({
        headers: { Accept: "application/json", Authorization: "Bearer endpoint-key" },
      }),
    );
  });

  it("does not treat an ambient Cloud key alone as local-daemon ownership", async () => {
    const fetchFn = vi.fn();
    const summary = await loadProviderUsageSummary({
      providers: ["ollama"],
      config: { plugins: { allow: ["ollama"], entries: { ollama: { enabled: true } } } },
      env: { OLLAMA_API_KEY: "ambient-cloud-key" },
      fetch: fetchFn,
      timeoutMs: 5000,
    });
    expect(summary.providers).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("keeps an implicit local marker usable alongside hosted configuration", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({ included: { session: { remaining_percent: 80 } } }),
    );
    const summary = await loadProviderUsageSummary({
      providers: ["ollama"],
      config: hostedOnlyConfig(),
      env: { OLLAMA_API_KEY: "ollama-local" },
      fetch: fetchFn,
      timeoutMs: 5000,
    });
    expect(summary.providers[0]?.windows).toEqual([{ label: "Session", usedPercent: 20 }]);
    expect(fetchFn).toHaveBeenCalledExactlyOnceWith(
      "http://127.0.0.1:11434/api/balance",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("recognizes an explicitly selected local model beside hosted credentials", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({ included: { session: { remaining_percent: 80 } } }),
    );
    const summary = await loadProviderUsageSummary({
      providers: ["ollama"],
      config: {
        ...hostedOnlyConfig(),
        agents: { defaults: { model: { primary: "ollama/test" } } },
      },
      env: { OLLAMA_API_KEY: "ambient-cloud-key" },
      fetch: fetchFn,
      timeoutMs: 5000,
    });
    expect(summary.providers[0]?.windows).toEqual([{ label: "Session", usedPercent: 20 }]);
    expect(fetchFn).toHaveBeenCalledExactlyOnceWith(
      "http://127.0.0.1:11434/api/balance",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });
});
