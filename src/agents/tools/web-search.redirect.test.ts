import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  fetchWithSsrFGuardMock,
  withStrictGuardedFetchModeMock,
  withTrustedEnvProxyGuardedFetchModeMock,
} = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
  withStrictGuardedFetchModeMock: vi.fn((params) => params),
  withTrustedEnvProxyGuardedFetchModeMock: vi.fn((params) => params),
}));

vi.mock("../../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  withStrictGuardedFetchMode: withStrictGuardedFetchModeMock,
  withTrustedEnvProxyGuardedFetchMode: withTrustedEnvProxyGuardedFetchModeMock,
}));

import { __testing } from "./web-search.js";

describe("web_search redirect resolution hardening", () => {
  const { resolveRedirectUrl } = __testing;

  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    withStrictGuardedFetchModeMock.mockClear();
    withTrustedEnvProxyGuardedFetchModeMock.mockClear();
  });

  it("resolves redirects via SSRF-guarded HEAD requests", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://example.com/final",
      release,
    });

    const resolved = await resolveRedirectUrl("https://example.com/start");
    expect(resolved).toBe("https://example.com/final");
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/start",
        timeoutMs: 5000,
        init: { method: "HEAD" },
      }),
    );
    expect(withStrictGuardedFetchModeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/start",
        timeoutMs: 5000,
        init: { method: "HEAD" },
      }),
    );
    expect(fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.proxy).toBeUndefined();
    expect(fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.policy).toBeUndefined();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("falls back to the original URL when guarded resolution fails", async () => {
    fetchWithSsrFGuardMock.mockRejectedValue(new Error("blocked"));
    await expect(resolveRedirectUrl("https://example.com/start")).resolves.toBe(
      "https://example.com/start",
    );
  });
});
