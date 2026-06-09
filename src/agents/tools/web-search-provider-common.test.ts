// Shared web_search provider tests cover module-local cache isolation and SDK helper compatibility.
import { afterEach, describe, expect, it, vi } from "vitest";

const { captureHttpExchangeMock, isDebugProxyGlobalFetchPatchInstalledMock } = vi.hoisted(() => ({
  captureHttpExchangeMock: vi.fn(),
  isDebugProxyGlobalFetchPatchInstalledMock: vi.fn(() => false),
}));

vi.mock("../../proxy-capture/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../proxy-capture/runtime.js")>()),
  captureHttpExchange: captureHttpExchangeMock,
  isDebugProxyGlobalFetchPatchInstalled: isDebugProxyGlobalFetchPatchInstalledMock,
}));

afterEach(() => {
  captureHttpExchangeMock.mockClear();
  isDebugProxyGlobalFetchPatchInstalledMock.mockReset();
  isDebugProxyGlobalFetchPatchInstalledMock.mockReturnValue(false);
  delete process.env.OPENCLAW_DEBUG_PROXY_ENABLED;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("web_search shared cache", () => {
  it("keeps cache entries module-local instead of exposing them on a global symbol", async () => {
    // Cache state should die with the module instance; a global symbol would
    // leak search payloads across tests, sessions, and plugin reloads.
    vi.resetModules();
    delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.web-search.cache")];

    const module = await import("./web-search-provider-common.js");
    const cacheKey = "query:test";
    module.writeCachedSearchPayload(cacheKey, { ok: true }, 60_000);

    expect(module.readCachedSearchPayload(cacheKey)).toEqual({ ok: true, cached: true });
    expect(
      (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.web-search.cache")],
    ).toBeUndefined();
  });

  it("accepts shipped web-tools endpoint params with timeoutMs and no init", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      const response = new Response("ok");
      Object.defineProperty(response, "url", { value: "https://example.com/final" });
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const module = await import("./web-search-provider-common.js");

    const finalUrl = await module.withTrustedWebToolsEndpoint(
      { url: "https://example.com/start", timeoutMs: 5000 },
      async ({ response, finalUrl: resolvedFinalUrl }) => {
        expect(await response.text()).toBe("ok");
        return resolvedFinalUrl;
      },
    );

    expect(finalUrl).toBe("https://example.com/final");
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("strips custom secret headers and bodies on cross-origin endpoint redirects", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { location: "https://redirect.example/collect" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const module = await import("./web-search-provider-common.js");

    const finalUrl = await module.withTrustedWebToolsEndpoint(
      {
        url: "https://api.example/search",
        timeoutMs: 5000,
        init: {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Api-Key": "secret",
          },
          body: JSON.stringify({ query: "openclaw" }),
        },
      },
      async ({ response, finalUrl: resolvedFinalUrl }) => {
        expect(await response.text()).toBe("ok");
        return resolvedFinalUrl;
      },
    );

    expect(finalUrl).toBe("https://redirect.example/collect");
    const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
    expect(secondInit?.body).toBeUndefined();
    const headers = new Headers(secondInit?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.has("content-type")).toBe(false);
    expect(headers.has("x-api-key")).toBe(false);
  });

  it("keeps deprecated endpoint option shape while honoring redirect and HTTPS knobs", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://redirect.example/collect" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const module = await import("./web-search-provider-common.js");

    await expect(
      module.withTrustedWebToolsEndpoint(
        {
          url: "https://api.example/search",
          timeoutMs: 5000,
          maxRedirects: 0,
          requireHttps: true,
          dispatcherPolicy: { mode: "direct" },
          auditContext: "compat-test",
        },
        async () => "unused",
      ),
    ).rejects.toThrow("Web tools endpoint exceeded redirect limit (0)");
    expect(fetchMock).toHaveBeenCalledOnce();
    const firstFetchInit = (
      fetchMock.mock.calls as unknown as Array<[unknown, unknown]>
    )[0]?.[1] as { dispatcher?: unknown } | undefined;
    expect(firstFetchInit?.dispatcher).toBeDefined();

    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "http://redirect.example/collect" },
      }),
    );
    await expect(
      module.withTrustedWebToolsEndpoint(
        {
          url: "https://api.example/search",
          timeoutMs: 5000,
          maxRedirects: 1,
          requireHttps: true,
        },
        async () => "unused",
      ),
    ).rejects.toThrow("Web tools endpoint requires an HTTPS URL");

    await expect(
      module.fetchWithWebToolsNetworkGuard({
        url: "http://api.example/search",
        requireHttps: true,
        policy: {},
      }),
    ).rejects.toThrow("Web tools endpoint requires an HTTPS URL");
  });

  it("captures dispatcher-backed deprecated web-tools guard HTTP exchanges", async () => {
    process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"),
    );
    vi.stubGlobal("fetch", fetchMock);
    const module = await import("./web-search-provider-common.js");

    const result = await module.fetchWithWebToolsNetworkGuard({
      url: "https://api.example/search",
      timeoutMs: 5000,
      dispatcherPolicy: { mode: "direct" },
      auditContext: "web-search",
      capture: { meta: { provider: "example" } },
    });
    await result.release();

    expect(captureHttpExchangeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.example/search",
        method: "GET",
        response: expect.any(Response),
        transport: "http",
        meta: {
          captureOrigin: "web-tools-endpoint",
          auditContext: "web-search",
          provider: "example",
        },
      }),
      expect.objectContaining({ enabled: true }),
    );
  });

  it("cleans endpoint timeouts when fetch rejects before returning a response", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const module = await import("./web-search-provider-common.js");

    await expect(
      module.withTrustedWebToolsEndpoint(
        { url: "https://api.example/search", timeoutMs: 5000 },
        async () => "unused",
      ),
    ).rejects.toThrow("network down");

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it("cancels the response body when deprecated web-tools guard results are released", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      cancel,
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body)),
    );
    const module = await import("./web-search-provider-common.js");

    const result = await module.fetchWithWebToolsNetworkGuard({
      url: "https://api.example/search",
      timeoutMs: 5000,
      dispatcherPolicy: { mode: "direct" },
      policy: {},
    });
    await result.release();

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("uses a dispatcher for deprecated web-tools guard capture opt-out", async () => {
    process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
    vi.stubEnv("HTTPS_PROXY", "");
    vi.stubEnv("NO_PROXY", "");
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"),
    );
    vi.stubGlobal("fetch", fetchMock);
    const module = await import("./web-search-provider-common.js");

    const result = await module.fetchWithWebToolsNetworkGuard({
      url: "https://api.example/search",
      timeoutMs: 5000,
      capture: false,
    });
    await result.release();

    const init = fetchMock.mock.calls[0]?.[1] as { dispatcher?: unknown } | undefined;
    expect(init?.dispatcher).toBeDefined();
    expect(init?.dispatcher?.constructor?.name).toContain("EnvHttpProxyAgent");
    expect(captureHttpExchangeMock).not.toHaveBeenCalled();
  });

  it("rejects deprecated SSRF knobs in the deprecated web-tools guard", async () => {
    const module = await import("./web-search-provider-common.js");

    await expect(
      module.fetchWithWebToolsNetworkGuard({
        url: "https://api.example/search",
        useEnvProxy: true,
      } as never),
    ).rejects.toThrow(
      "fetchWithWebToolsNetworkGuard no longer supports useEnvProxy; use proxy.enabled plus external proxy policy",
    );
    await expect(
      module.fetchWithWebToolsNetworkGuard({
        url: "https://api.example/search",
        pinDns: true,
      } as never),
    ).rejects.toThrow(
      "fetchWithWebToolsNetworkGuard no longer supports pinDns; use proxy.enabled plus external proxy policy",
    );
    await expect(
      module.fetchWithWebToolsNetworkGuard({
        url: "https://api.example/search",
        policy: { allowPrivateNetwork: true },
      } as never),
    ).rejects.toThrow(
      "Web tools endpoint policy only supports hostname/origin allowlists; unsupported field: allowPrivateNetwork",
    );
  });

  it("uses env proxy dispatch for trusted web-tools endpoints with capture enabled", async () => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
    vi.stubEnv("HTTPS_PROXY", "");
    vi.stubEnv("NO_PROXY", "");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    const module = await import("./web-search-provider-common.js");

    const result = await module.postTrustedWebToolsJson<{ ok: boolean }>(
      {
        url: "https://api.example/search",
        timeoutSeconds: 5,
        apiKey: "test-key",
        body: { query: "openclaw" },
        errorLabel: "Example",
      },
      async (response) => (await response.json()) as { ok: boolean },
    );

    expect(result).toEqual({ ok: true });
    const init = fetchMock.mock.calls[0]?.[1] as { dispatcher?: unknown } | undefined;
    expect(init?.dispatcher).toBeDefined();
    expect(init?.dispatcher?.constructor?.name).toContain("EnvHttpProxyAgent");
  });

  it("honors explicit allowlists in the deprecated web-tools guard", async () => {
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const module = await import("./web-search-provider-common.js");

    await expect(
      module.fetchWithWebToolsNetworkGuard({
        url: "https://blocked.example/search",
        timeoutMs: 5000,
        policy: { allowedHostnames: ["allowed.example"] },
      }),
    ).rejects.toMatchObject({
      name: "SsrFBlockedError",
      message: "Blocked hostname (not in allowlist): blocked.example",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honors explicit origin allowlists in the deprecated web-tools guard", async () => {
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const module = await import("./web-search-provider-common.js");

    await expect(
      module.fetchWithWebToolsNetworkGuard({
        url: "https://blocked.example:8443/search",
        timeoutMs: 5000,
        policy: { allowedOrigins: ["https://allowed.example:8443"] },
      }),
    ).rejects.toMatchObject({
      name: "SsrFBlockedError",
      message: "Blocked hostname (not in allowlist): blocked.example",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honors explicit allowlists for deprecated web-tools guard redirects", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://blocked.example/collect" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const module = await import("./web-search-provider-common.js");

    await expect(
      module.fetchWithWebToolsNetworkGuard({
        url: "https://allowed.example/search",
        timeoutMs: 5000,
        maxRedirects: 1,
        policy: { allowedHostnames: ["allowed.example"] },
      }),
    ).rejects.toMatchObject({
      name: "SsrFBlockedError",
      message: "Blocked hostname (not in allowlist): blocked.example",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("honors deprecated redirect authorization and unsafe replay compatibility options", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { location: "https://auth.example/collect" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const module = await import("./web-search-provider-common.js");

    const result = await module.fetchWithWebToolsNetworkGuard({
      url: "https://api.example/search",
      timeoutMs: 5000,
      maxRedirects: 1,
      allowCrossOriginUnsafeRedirectReplay: true,
      retainAuthorizationRedirectHostnameAllowlist: ["auth.example"],
      policy: { allowedHostnames: ["api.example", "auth.example"] },
      init: {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
          "X-Api-Key": "provider-secret",
        },
        body: JSON.stringify({ query: "openclaw" }),
      },
    });
    await result.release();

    const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
    expect(secondInit?.method).toBe("POST");
    expect(secondInit?.body).toBe(JSON.stringify({ query: "openclaw" }));
    const headers = new Headers(secondInit?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("authorization")).toBe("Bearer secret");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.has("x-api-key")).toBe(false);
  });
});
