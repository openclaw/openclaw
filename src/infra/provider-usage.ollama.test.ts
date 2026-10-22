import { afterEach, describe, expect, it, vi } from "vitest";
import { loadProviderUsageSummary } from "./provider-usage.load.js";

describe("Ollama provider usage integration", () => {
  afterEach(() => vi.restoreAllMocks());
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
  const balanceFetch = () =>
    vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ included: { session: { remaining_percent: 80 } } }));
  const load = (
    options: Omit<NonNullable<Parameters<typeof loadProviderUsageSummary>[0]>, "providers">,
  ) => loadProviderUsageSummary({ providers: ["ollama"], env: {}, timeoutMs: 5000, ...options });
  const expectRequest = (fetchFn: ReturnType<typeof balanceFetch>, url: string, key?: string) =>
    expect(fetchFn).toHaveBeenCalledExactlyOnceWith(
      `${url}/api/balance`,
      expect.objectContaining({
        headers: { Accept: "application/json", ...(key && { Authorization: `Bearer ${key}` }) },
      }),
    );

  it("loads balance through the configured local provider", async () => {
    const fetchFn = balanceFetch();
    const summary = await load({
      config: configFor("http://127.0.0.1:11434/v1", "ollama-local"),
    });
    expect(summary.providers).toEqual([
      expect.objectContaining({
        provider: "ollama",
        windows: [{ label: "Session", usedPercent: 20 }],
      }),
    ]);
    expectRequest(fetchFn, "http://127.0.0.1:11434");
  });

  it.each([401, 404])("omits unavailable Cloud balance for HTTP %i", async (status) => {
    const fetchFn = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("private", { status }));
    const summary = await load({
      config: configFor("http://127.0.0.1:11434", "ollama-local"),
    });
    expect(summary.providers).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["ollama-local", { Accept: "application/json" }],
    ["OLLAMA_API_KEY", { Accept: "application/json" }],
    ["endpoint-key", { Accept: "application/json", Authorization: "Bearer endpoint-key" }],
  ])("keeps ambient Cloud auth off LAN requests with %s", async (apiKey, headers) => {
    const fetchFn = balanceFetch();
    const summary = await load({
      config: configFor("http://10.0.0.5:11434", apiKey),
      env: { OLLAMA_API_KEY: "ambient-cloud-key" },
    });
    expect(summary.providers[0]?.error).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledExactlyOnceWith(
      "http://10.0.0.5:11434/api/balance",
      expect.objectContaining({ headers }),
    );
  });

  it.each([
    [undefined, {}],
    [undefined, { OLLAMA_API_KEY: "ambient-cloud-key" }],
    ["OLLAMA_API_KEY", {}],
    ["OLLAMA_API_KEY", { OLLAMA_API_KEY: "ambient-cloud-key" }],
    ["ollama-local", {}],
    ["ollama-local", { OLLAMA_API_KEY: "ambient-cloud-key" }],
  ])("uses stored endpoint credentials with local key %s and env %j", async (apiKey, env) => {
    const fetchFn = balanceFetch();
    const summary = await load({
      config: configFor("http://10.0.0.5:11434", apiKey),
      authStore: {
        version: 1,
        profiles: {
          "ollama:endpoint": { type: "api_key", provider: "ollama", key: "endpoint-key" },
        },
      },
      env,
    });
    expect(summary.providers[0]?.windows).toEqual([{ label: "Session", usedPercent: 20 }]);
    expectRequest(fetchFn, "http://10.0.0.5:11434", "endpoint-key");
  });

  it.each([
    ["hosted-only credentials", hostedOnlyConfig(), undefined, false],
    ["ambient Cloud key alone", { plugins: configFor("").plugins }, "ambient-cloud-key", false],
    ["implicit local marker", hostedOnlyConfig(), "ollama-local", true],
    [
      "selected local model",
      {
        ...hostedOnlyConfig(),
        agents: { defaults: { model: { primary: "ollama/test" } } },
      },
      "ambient-cloud-key",
      true,
    ],
  ] as const)("resolves local-daemon ownership for %s", async (_name, config, apiKey, local) => {
    const fetchFn = local
      ? balanceFetch()
      : vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected usage fetch"));
    const env = apiKey ? { OLLAMA_API_KEY: apiKey } : {};
    const summary = await load({ config, env });
    if (local) {
      expect(summary.providers[0]?.windows).toEqual([{ label: "Session", usedPercent: 20 }]);
      expectRequest(fetchFn, "http://127.0.0.1:11434");
    } else {
      expect(summary.providers).toEqual([]);
      expect(fetchFn).not.toHaveBeenCalled();
    }
  });
});
