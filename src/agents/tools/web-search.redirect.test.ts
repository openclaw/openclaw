import { beforeEach, describe, expect, it, vi } from "vitest";

const { withStrictWebToolsEndpointMock } = vi.hoisted(() => ({
  withStrictWebToolsEndpointMock: vi.fn(),
}));

vi.mock("./web-guarded-fetch.js", () => ({
  withStrictWebToolsEndpoint: withStrictWebToolsEndpointMock,
}));

describe("web_search redirect resolution hardening", () => {
  async function resolveRedirectUrl() {
    const module = await import("./web-search-citation-redirect.js");
    return module.resolveCitationRedirectUrl;
  }

  beforeEach(() => {
    vi.resetModules();
    withStrictWebToolsEndpointMock.mockReset();
  });

  it("resolves redirects via SSRF-guarded HEAD requests", async () => {
    const resolve = await resolveRedirectUrl();
    withStrictWebToolsEndpointMock.mockImplementation(async (_params, run) => {
      return await run({
        response: new Response(null, { status: 200 }),
        finalUrl: "https://example.com/final",
      });
    });

    const resolved = await resolve("https://example.com/start");
    expect(resolved).toBe("https://example.com/final");
    expect(withStrictWebToolsEndpointMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/start",
        timeoutMs: 5000,
        init: { method: "HEAD" },
      }),
      expect.any(Function),
    );
  });

  it("falls back to the original URL when guarded resolution fails", async () => {
    const resolve = await resolveRedirectUrl();
    withStrictWebToolsEndpointMock.mockRejectedValue(new Error("blocked"));
    await expect(resolve("https://example.com/start")).resolves.toBe("https://example.com/start");
  });
});
