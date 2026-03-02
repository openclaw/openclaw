import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import { withStrictWebToolsEndpoint, withTrustedWebToolsEndpoint } from "./web-guarded-fetch.js";

vi.mock("../../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: vi.fn(),
}));

describe("web-guarded-fetch", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses trusted SSRF policy for trusted web tools endpoints", async () => {
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await withTrustedWebToolsEndpoint({ url: "https://example.com" }, async () => undefined);

    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com",
        policy: expect.objectContaining({
          dangerouslyAllowPrivateNetwork: true,
          allowRfc2544BenchmarkRange: true,
        }),
      }),
    );
  });

  it("keeps strict endpoint policy unchanged", async () => {
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await withStrictWebToolsEndpoint({ url: "https://example.com" }, async () => undefined);

    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com",
      }),
    );
    const call = vi.mocked(fetchWithSsrFGuard).mock.calls[0]?.[0];
    expect(call?.policy).toBeUndefined();
  });
});
