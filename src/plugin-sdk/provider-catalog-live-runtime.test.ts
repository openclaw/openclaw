import { afterEach, beforeEach, describe, expect, it, vi, type MockedFunction } from "vitest";
import {
  registerActiveManagedProxyUrl,
  resetActiveManagedProxyStateForTests,
} from "../infra/net/proxy/active-proxy-state.js";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import { NON_ENV_SECRETREF_MARKER } from "./provider-auth-runtime.js";
import {
  buildLiveModelProviderConfig,
  clearLiveCatalogCacheForTests,
  fetchLiveProviderModelRows,
  fetchLiveProviderModelIds,
  getCachedLiveProviderModelRows,
  LiveModelCatalogHttpError,
  type LiveModelCatalogFetchGuard,
} from "./provider-catalog-live-runtime.js";
import type { ModelDefinitionConfig } from "./provider-model-shared.js";
import type { LookupFn } from "./ssrf-policy.js";

const { captureHttpExchangeMock } = vi.hoisted(() => ({
  captureHttpExchangeMock: vi.fn(),
}));

vi.mock("../proxy-capture/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../proxy-capture/runtime.js")>()),
  captureHttpExchange: captureHttpExchangeMock,
}));

function buildModel(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

function buildFetchGuard(body: unknown): {
  fetchGuard: LiveModelCatalogFetchGuard;
  fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard>;
  release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn(async () => undefined);
  const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async () => ({
    response: new Response(JSON.stringify(body)),
    finalUrl: "https://provider.example.test/v1/models",
    release,
  }));
  return { fetchGuard: fetchGuardMock, fetchGuardMock, release };
}

describe("provider-catalog-live-runtime", () => {
  beforeEach(() => {
    captureHttpExchangeMock.mockClear();
    clearLiveCatalogCacheForTests();
    delete process.env.OPENCLAW_DEBUG_PROXY_ENABLED;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetActiveManagedProxyStateForTests();
  });

  it("fetches and dedupes OpenAI-style live model ids with resolved discovery auth", async () => {
    const { fetchGuard, fetchGuardMock, release } = buildFetchGuard({
      data: [
        { id: "model-a", object: "model" },
        { id: "model-b", object: "model" },
        { id: "embedding-a", object: "embedding" },
        { id: "model-a", object: "model" },
      ],
    });
    const controller = new AbortController();

    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        apiKey: "PROVIDER_API_KEY",
        discoveryApiKey: "resolved-provider-key",
        fetchGuard,
        signal: controller.signal,
        timeoutMs: 1234,
      }),
    ).resolves.toEqual(["model-a", "model-b"]);

    expect(fetchGuardMock).toHaveBeenCalledTimes(1);
    const request = fetchGuardMock.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      url: "https://provider.example.test/v1/models",
      auditContext: "provider-model-discovery",
      timeoutMs: 1234,
      signal: controller.signal,
      policy: { allowedHostnames: ["provider.example.test"] },
    });
    const headers = request?.init?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("authorization")).toBe("Bearer resolved-provider-key");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not send non-secret SecretRef markers as live catalog bearer tokens", async () => {
    const { fetchGuard, fetchGuardMock } = buildFetchGuard({ data: [] });
    const buildRequestHeaders = vi.fn(({ apiKey, discoveryApiKey }) => ({
      Accept: "application/json",
      ...(discoveryApiKey ? { Authorization: `Bearer ${discoveryApiKey}` } : {}),
      ...(apiKey ? { "X-Api-Key": apiKey } : {}),
    }));

    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        apiKey: NON_ENV_SECRETREF_MARKER,
        fetchGuard,
        buildRequestHeaders,
      }),
    ).resolves.toEqual([]);

    expect(buildRequestHeaders).toHaveBeenCalledWith({
      apiKey: undefined,
      discoveryApiKey: undefined,
    });
    const headers = fetchGuardMock.mock.calls[0]?.[0].init?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("authorization")).toBeNull();
    expect((headers as Headers).get("x-api-key")).toBeNull();
  });

  it("rejects HTTPS-required live catalog redirects to HTTP without a fetch guard", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://provider.example.test/v1/models" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchLiveProviderModelRows({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        requireHttps: true,
      }),
    ).rejects.toThrow("provider model discovery requires an https endpoint");

    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://provider.example.test/v1/models",
      expect.objectContaining({ redirect: "manual" }),
    );
    clearTimeoutSpy.mockRestore();
  });

  it("strips provider credentials on cross-origin live catalog redirects", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://catalog-cdn.example.test/v1/models" },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchLiveProviderModelRows({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        discoveryApiKey: "provider-secret",
        requireHttps: true,
        policy: {
          allowedHostnames: ["provider.example.test", "catalog-cdn.example.test"],
        },
      }),
    ).resolves.toEqual([]);

    const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
    const headers = new Headers(secondInit?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.has("authorization")).toBe(false);
  });

  it("rejects direct live catalog redirects outside the default endpoint host policy", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://catalog-cdn.example.test/v1/models" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchLiveProviderModelRows({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        requireHttps: true,
      }),
    ).rejects.toThrow(SsrFBlockedError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves direct live catalog allowlist failures before a response exists", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchLiveProviderModelRows({
        providerId: "provider",
        endpoint: "https://blocked.example.test/v1/models",
        policy: { allowedHostnames: ["provider.example.test"] },
      }),
    ).rejects.toThrow(SsrFBlockedError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects direct live catalogs outside explicit origin allowlists before fetching", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchLiveProviderModelRows({
        providerId: "provider",
        endpoint: "https://blocked.example.test:8443/v1/models",
        policy: { allowedOrigins: ["https://provider.example.test:8443"] },
      }),
    ).rejects.toThrow(SsrFBlockedError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records direct live catalog HTTP exchanges for debug proxy capture", async () => {
    process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchLiveProviderModelRows({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        auditContext: "custom-discovery",
      }),
    ).resolves.toEqual([]);

    expect(captureHttpExchangeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://provider.example.test/v1/models",
        method: "GET",
        response: expect.any(Response),
        transport: "http",
        meta: {
          captureOrigin: "live-model-catalog",
          provider: "provider",
          auditContext: "custom-discovery",
        },
      }),
      expect.objectContaining({ enabled: true }),
    );
  });

  it("threads direct live catalog lookup functions into the fetch dispatcher", async () => {
    const lookupFn = vi.fn(async () => [
      { address: "203.0.113.10", family: 4 },
    ]) as unknown as LookupFn;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchLiveProviderModelRows({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        policy: { allowedHostnames: ["provider.example.test"] },
        lookupFn,
      }),
    ).resolves.toEqual([]);

    expect(lookupFn).toHaveBeenCalledWith("provider.example.test", { all: true });
    const init = (fetchMock.mock.calls[0] as unknown[] | undefined)?.[1] as
      | { dispatcher?: unknown }
      | undefined;
    expect(init?.dispatcher).toBeDefined();
  });

  it("does not install a direct lookup dispatcher while managed proxy routing is active", async () => {
    registerActiveManagedProxyUrl(new URL("http://127.0.0.1:19090"), "proxy");
    const lookupFn = vi.fn(async () => [
      { address: "203.0.113.10", family: 4 },
    ]) as unknown as LookupFn;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchLiveProviderModelRows({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        policy: { allowedHostnames: ["provider.example.test"] },
        lookupFn,
      }),
    ).resolves.toEqual([]);

    expect(lookupFn).not.toHaveBeenCalled();
    const init = (fetchMock.mock.calls[0] as unknown[] | undefined)?.[1] as
      | { dispatcher?: unknown }
      | undefined;
    expect(init?.dispatcher).toBeUndefined();
  });

  it("rejects direct live catalog redirects outside the configured host policy", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://unexpected.example.test/v1/models" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchLiveProviderModelRows({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        policy: { allowedHostnames: ["provider.example.test"] },
      }),
    ).rejects.toThrow(SsrFBlockedError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("supports top-level array bodies and custom row readers", async () => {
    const { fetchGuard } = buildFetchGuard([
      { slug: "custom-a" },
      { slug: "custom-b" },
      { slug: "custom-a" },
    ]);

    await expect(
      fetchLiveProviderModelIds({
        providerId: "custom",
        endpoint: "https://provider.example.test/v1/models",
        fetchGuard,
        readModelId: (row) =>
          row && typeof row === "object" && "slug" in row && typeof row.slug === "string"
            ? row.slug
            : undefined,
      }),
    ).resolves.toEqual(["custom-a", "custom-b"]);
  });

  it("caches raw live model rows for provider-specific projection", async () => {
    const { fetchGuard, fetchGuardMock } = buildFetchGuard({
      models: [{ slug: "custom-a" }, { slug: "custom-b" }],
    });

    const first = await getCachedLiveProviderModelRows({
      providerId: "custom",
      endpoint: "https://provider.example.test/v1/models",
      fetchGuard,
      ttlMs: 60_000,
      readRows: (body) =>
        body && typeof body === "object" && Array.isArray((body as { models?: unknown }).models)
          ? (body as { models: unknown[] }).models
          : [],
    });
    const second = await getCachedLiveProviderModelRows({
      providerId: "custom",
      endpoint: "https://provider.example.test/v1/models",
      fetchGuard,
      ttlMs: 60_000,
      readRows: (body) =>
        body && typeof body === "object" && Array.isArray((body as { models?: unknown }).models)
          ? (body as { models: unknown[] }).models
          : [],
    });

    expect(first).toEqual([{ slug: "custom-a" }, { slug: "custom-b" }]);
    expect(second).toEqual(first);
    expect(fetchGuardMock).toHaveBeenCalledTimes(1);
  });

  it("throws structured HTTP errors after releasing guarded fetches", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async () => ({
      response: new Response("{}", { status: 401 }),
      finalUrl: "https://provider.example.test/v1/models",
      release,
    }));

    const error = await fetchLiveProviderModelIds({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      fetchGuard: fetchGuardMock,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(LiveModelCatalogHttpError);
    expect(error).toMatchObject({ status: 401 });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("caches live provider configs and falls back to static rows on failure", async () => {
    const { fetchGuard, fetchGuardMock } = buildFetchGuard([
      { id: "model-b", object: "model" },
      { id: "unknown-model", object: "model" },
    ]);
    const providerConfig = {
      api: "openai-completions" as const,
      baseUrl: "https://provider.example.test/v1",
    };
    const models = [buildModel("model-a"), buildModel("model-b")];

    const first = await buildLiveModelProviderConfig({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      providerConfig,
      apiKey: "PROVIDER_API_KEY",
      discoveryApiKey: "resolved-provider-key",
      fetchGuard,
      models,
      ttlMs: 60_000,
    });
    const second = await buildLiveModelProviderConfig({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      providerConfig,
      apiKey: "PROVIDER_API_KEY",
      discoveryApiKey: "resolved-provider-key",
      fetchGuard,
      models,
      ttlMs: 60_000,
    });

    expect(fetchGuardMock).toHaveBeenCalledTimes(1);
    expect(first.apiKey).toBe("PROVIDER_API_KEY");
    expect(first.models.map((model) => model.id)).toEqual(["model-b"]);
    expect(second.models.map((model) => model.id)).toEqual(["model-b"]);

    clearLiveCatalogCacheForTests();
    fetchGuardMock.mockRejectedValueOnce(new Error("network unavailable"));
    const fallback = await buildLiveModelProviderConfig({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      providerConfig,
      apiKey: "PROVIDER_API_KEY",
      discoveryApiKey: "resolved-provider-key",
      fetchGuard,
      models,
    });

    expect(fallback.apiKey).toBe("PROVIDER_API_KEY");
    expect(fallback.models.map((model) => model.id)).toEqual(["model-a", "model-b"]);
  });

  it("does not cache empty live provider config discoveries", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi
      .fn()
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ data: [] })),
        finalUrl: "https://provider.example.test/v1/models",
        release,
      })
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ data: [{ id: "model-b", object: "model" }] })),
        finalUrl: "https://provider.example.test/v1/models",
        release,
      });
    const providerConfig = {
      api: "openai-completions" as const,
      baseUrl: "https://provider.example.test/v1",
    };
    const models = [buildModel("model-a"), buildModel("model-b")];

    const fallback = await buildLiveModelProviderConfig({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      providerConfig,
      fetchGuard: fetchGuardMock,
      models,
      ttlMs: 60_000,
    });
    const recovered = await buildLiveModelProviderConfig({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      providerConfig,
      fetchGuard: fetchGuardMock,
      models,
      ttlMs: 60_000,
    });

    expect(fallback.models.map((model) => model.id)).toEqual(["model-a", "model-b"]);
    expect(recovered.models.map((model) => model.id)).toEqual(["model-b"]);
    expect(fetchGuardMock).toHaveBeenCalledTimes(2);
  });
});
