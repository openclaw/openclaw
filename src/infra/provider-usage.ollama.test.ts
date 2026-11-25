import { afterEach, describe, expect, it, vi } from "vitest";
import { loadProviderUsageSummary } from "./provider-usage.load.js";

const configFor = (baseUrl: string, apiKey?: string) => ({
  models: { providers: { ollama: { baseUrl, api: "ollama" as const, apiKey, models: [] } } },
  plugins: { allow: ["ollama"], entries: { ollama: { enabled: true } } },
});
const hostedOnlyConfig = () => ({
  ...configFor(""),
  models: {
    providers: {
      "ollama-cloud": configFor("https://ollama.com", "hosted-key").models.providers.ollama,
    },
  },
});
const windows = [{ label: "Session", usedPercent: 20 }];
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

describe("Ollama provider usage integration", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    {
      apiKey: "ollama-local",
      baseUrl: "http://127.0.0.1:11434/v1",
      endpoint: "http://127.0.0.1:11434",
    },
    { apiKey: "OLLAMA_API_KEY" },
    { apiKey: "endpoint-key", expectedKey: "endpoint-key" },
    { apiKey: undefined, stored: true, expectedKey: "endpoint-key" },
    { apiKey: "OLLAMA_API_KEY", stored: true, expectedKey: "endpoint-key" },
    { apiKey: "ollama-local", stored: true, expectedKey: "endpoint-key", ambient: false },
  ])(
    "loads endpoint balance without leaking ambient auth: %j",
    async ({
      apiKey,
      baseUrl = "http://10.0.0.5:11434",
      endpoint = baseUrl,
      stored = false,
      expectedKey,
      ambient = true,
    }) => {
      const fetchFn = balanceFetch();
      const summary = await load({
        config: configFor(baseUrl, apiKey),
        env: ambient ? { OLLAMA_API_KEY: "ambient-cloud-key" } : {},
        ...(stored
          ? {
              authStore: {
                version: 1,
                profiles: {
                  "ollama:endpoint": {
                    type: "api_key" as const,
                    provider: "ollama",
                    key: "endpoint-key",
                  },
                },
              },
            }
          : {}),
      });
      expect(summary.providers).toEqual([expect.objectContaining({ provider: "ollama", windows })]);
      expect(summary.providers[0]?.error).toBeUndefined();
      expectRequest(fetchFn, endpoint, expectedKey);
    },
  );

  it.each([401, 404])("omits unavailable Cloud balance for HTTP %i", async (status) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("private", { status }));
    expect(
      (await load({ config: configFor("http://127.0.0.1:11434", "ollama-local") })).providers,
    ).toEqual([]);
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
    const summary = await load({ config, env: apiKey ? { OLLAMA_API_KEY: apiKey } : {} });
    if (local) {
      expect(summary.providers[0]?.windows).toEqual(windows);
      expectRequest(fetchFn, "http://127.0.0.1:11434");
    } else {
      expect(summary.providers).toEqual([]);
      expect(fetchFn).not.toHaveBeenCalled();
    }
  });
});
