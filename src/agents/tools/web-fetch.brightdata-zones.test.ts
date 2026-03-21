import { beforeEach, describe, expect, it, vi } from "vitest";

const { withTrustedWebToolsEndpointMock } = vi.hoisted(() => ({
  withTrustedWebToolsEndpointMock: vi.fn(),
}));

vi.mock("./web-guarded-fetch.js", () => ({
  fetchWithWebToolsNetworkGuard: vi.fn(),
  withTrustedWebToolsEndpoint: withTrustedWebToolsEndpointMock,
}));

describe("fetchBrightDataContent zone bootstrap", () => {
  beforeEach(() => {
    vi.resetModules();
    withTrustedWebToolsEndpointMock.mockReset();
  });

  it("ensures the unlocker zone once before Bright Data requests", async () => {
    const { __testing, fetchBrightDataContent } = await import("./web-fetch.js");
    __testing.resetBrightDataZoneEnsureCache();

    const zoneCalls: string[] = [];
    withTrustedWebToolsEndpointMock.mockImplementation(
      async (
        params: { url: string; init?: RequestInit },
        run: (result: { response: Response; finalUrl: string }) => Promise<unknown>,
      ) => {
        zoneCalls.push(params.url);
        if (params.url.endsWith("/zone/get_active_zones")) {
          return await run({
            response: new Response(JSON.stringify([]), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
            finalUrl: params.url,
          });
        }
        if (params.url.endsWith("/zone")) {
          const body = params.init?.body;
          expect(typeof body).toBe("string");
          if (typeof body !== "string") {
            throw new Error("Expected Bright Data zone bootstrap request body to be a string");
          }
          expect(JSON.parse(body)).toEqual({
            zone: { name: "mcp_unlocker", type: "unblocker" },
            plan: { type: "unblocker", ub_premium: true },
          });
          return await run({
            response: new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
            finalUrl: params.url,
          });
        }
        if (params.url.endsWith("/request")) {
          return await run({
            response: new Response("# Bright Data\n\nFallback content", {
              status: 200,
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            }),
            finalUrl: params.url,
          });
        }
        throw new Error(`Unexpected URL in test mock: ${params.url}`);
      },
    );

    const first = await fetchBrightDataContent({
      url: "https://example.com/blocked-1",
      extractMode: "markdown",
      apiKey: "brightdata-test",
      baseUrl: "https://api.brightdata.com",
      unlockerZone: "mcp_unlocker",
      timeoutSeconds: 30,
    });
    const second = await fetchBrightDataContent({
      url: "https://example.com/blocked-2",
      extractMode: "markdown",
      apiKey: "brightdata-test",
      baseUrl: "https://api.brightdata.com",
      unlockerZone: "mcp_unlocker",
      timeoutSeconds: 30,
    });

    expect(first).toMatchObject({ extractor: "brightdata" });
    expect(second).toMatchObject({ extractor: "brightdata" });
    expect(zoneCalls.filter((url) => url.endsWith("/zone/get_active_zones"))).toHaveLength(1);
    expect(zoneCalls.filter((url) => url.endsWith("/zone"))).toHaveLength(1);
    expect(zoneCalls.filter((url) => url.endsWith("/request"))).toHaveLength(2);
  });
});
