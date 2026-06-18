// Shared web_search provider tests cover module-local cache isolation.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { withSelfHostedWebToolsEndpointMock, withTrustedWebToolsEndpointMock } = vi.hoisted(() => ({
  withSelfHostedWebToolsEndpointMock: vi.fn(),
  withTrustedWebToolsEndpointMock: vi.fn(),
}));

vi.mock("./web-guarded-fetch.js", () => ({
  withSelfHostedWebToolsEndpoint: withSelfHostedWebToolsEndpointMock,
  withTrustedWebToolsEndpoint: withTrustedWebToolsEndpointMock,
}));

beforeEach(() => {
  withSelfHostedWebToolsEndpointMock.mockReset();
  withTrustedWebToolsEndpointMock.mockReset();
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

  it("posts trusted JSON web tools through the self-hosted guard for private HTTP endpoints", async () => {
    vi.resetModules();
    withSelfHostedWebToolsEndpointMock.mockImplementation(async (_params, run) => {
      return await run({
        response: new Response(JSON.stringify({ ok: true }), { status: 200 }),
        finalUrl: "http://web-tools.internal:4000/v1/responses",
      });
    });

    const module = await import("./web-search-provider-common.js");
    const parsed = await module.postTrustedWebToolsJson(
      {
        url: "http://web-tools.internal:4000/v1/responses",
        timeoutSeconds: 30,
        apiKey: "egsk_proxy_key", // pragma: allowlist secret
        body: { model: "grok-4-1-fast", input: "search", tools: [{ type: "x_search" }] },
        errorLabel: "xAI",
      },
      async (response) => ({ status: response.status }),
    );

    expect(parsed).toEqual({ status: 200 });
    expect(withSelfHostedWebToolsEndpointMock).toHaveBeenCalledOnce();
    expect(withTrustedWebToolsEndpointMock).not.toHaveBeenCalled();
    const [params] = withSelfHostedWebToolsEndpointMock.mock.calls[0] as [
      {
        url?: string;
        timeoutSeconds?: number;
        init?: { method?: string; headers?: Record<string, string>; body?: string };
      },
      unknown,
    ];
    expect(params.url).toBe("http://web-tools.internal:4000/v1/responses");
    expect(params.timeoutSeconds).toBe(30);
    expect(params.init?.method).toBe("POST");
    expect(params.init?.headers?.Authorization).toBe("Bearer egsk_proxy_key");
    expect(JSON.parse(params.init?.body ?? "{}")).toMatchObject({ tools: [{ type: "x_search" }] });
  });

  it("keeps HTTPS JSON web tools on the trusted guard", async () => {
    vi.resetModules();
    withTrustedWebToolsEndpointMock.mockImplementation(async (_params, run) => {
      return await run({
        response: new Response(JSON.stringify({ ok: true }), { status: 200 }),
        finalUrl: "https://api.example.test/v1/responses",
      });
    });

    const module = await import("./web-search-provider-common.js");
    const parsed = await module.postTrustedWebToolsJson(
      {
        url: "https://api.example.test/v1/responses",
        timeoutSeconds: 30,
        apiKey: "egsk_proxy_key", // pragma: allowlist secret
        body: { model: "grok-4-1-fast", input: "search", tools: [{ type: "x_search" }] },
        errorLabel: "xAI",
      },
      async (response) => ({ status: response.status }),
    );

    expect(parsed).toEqual({ status: 200 });
    expect(withTrustedWebToolsEndpointMock).toHaveBeenCalledOnce();
    expect(withSelfHostedWebToolsEndpointMock).not.toHaveBeenCalled();
  });
});
