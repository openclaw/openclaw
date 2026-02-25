import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("../../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { __testing } from "./web-search.js";

describe("web_search redirect resolution hardening", () => {
  const { resolveRedirectUrl } = __testing;

  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
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
        policy: { dangerouslyAllowPrivateNetwork: true },
      }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("falls back to the original URL when guarded resolution fails", async () => {
    fetchWithSsrFGuardMock.mockRejectedValue(new Error("blocked"));
    await expect(resolveRedirectUrl("https://example.com/start")).resolves.toBe(
      "https://example.com/start",
    );
  });
});
