// Shared web_search provider tests cover module-local cache isolation.
import { describe, expect, it, vi } from "vitest";

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
});

describe("web_search provider error redaction", () => {
  const SECRET = "sk-test-secret-0123456789abcdef";
  const REFLECTING_BODY = `<html><body>502 upstream failed for request with Authorization: Bearer ${SECRET}</body></html>`;

  async function captureThrowWebSearchApiError(res: Response): Promise<string> {
    const { throwWebSearchApiError } = await import("./web-search-provider-common.js");
    try {
      await throwWebSearchApiError(res, "Tavily");
    } catch (err) {
      return String(err);
    }
    throw new Error("expected throwWebSearchApiError to throw");
  }

  it("redacts reflected credentials in throwWebSearchApiError error bodies", async () => {
    const message = await captureThrowWebSearchApiError(
      new Response(REFLECTING_BODY, { status: 502, statusText: "Bad Gateway" }),
    );
    expect(message).toContain("Tavily API error (502)");
    expect(message).not.toContain(SECRET);
  });

  it("falls back to statusText when the error body is empty", async () => {
    const message = await captureThrowWebSearchApiError(
      new Response("", { status: 503, statusText: "Service Unavailable" }),
    );
    expect(message).toContain("Tavily API error (503): Service Unavailable");
  });

  it("redacts credentials reflected in the statusText fallback", async () => {
    const message = await captureThrowWebSearchApiError(
      new Response("", { status: 502, statusText: `Bad Gateway Authorization: Bearer ${SECRET}` }),
    );
    expect(message).toContain("Tavily API error (502)");
    expect(message).not.toContain(SECRET);
  });

  it("redacts reflected credentials in postTrustedWebToolsJson error bodies", async () => {
    vi.resetModules();
    vi.doMock("./web-guarded-fetch.js", () => ({
      withTrustedWebToolsEndpoint: async (
        _params: unknown,
        run: (result: { response: Response; finalUrl: string }) => Promise<unknown>,
      ) =>
        run({
          response: new Response(REFLECTING_BODY, { status: 502, statusText: "Bad Gateway" }),
          finalUrl: "https://api.tavily.com/search",
        }),
      withSelfHostedWebToolsEndpoint: async () => {
        throw new Error("not used in this test");
      },
    }));
    try {
      const { postTrustedWebToolsJson } = await import("./web-search-provider-common.js");
      let message = "";
      try {
        await postTrustedWebToolsJson(
          {
            url: "https://api.tavily.com/search",
            timeoutSeconds: 30,
            apiKey: SECRET,
            body: {},
            errorLabel: "Tavily",
          },
          async () => ({}),
        );
      } catch (err) {
        message = String(err);
      }
      expect(message).toContain("Tavily API error (502)");
      expect(message).not.toContain(SECRET);
    } finally {
      vi.doUnmock("./web-guarded-fetch.js");
    }
  });
});
