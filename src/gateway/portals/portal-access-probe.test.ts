import { afterEach, describe, expect, it, vi } from "vitest";
import { isCloudflareAccessLoginRedirect, probePortalAccess } from "./portal-access-probe.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("portal Access probe", () => {
  it.each([
    "https://preview.example.test/cdn-cgi/access/login/app?kid=one",
    "https://team.cloudflareaccess.com/cdn-cgi/access/login/app?redirect_url=preview",
  ])("recognizes Cloudflare Access login redirects at %s", (location) => {
    expect(isCloudflareAccessLoginRedirect("https://preview.example.test/app", location)).toBe(
      true,
    );
  });

  it("does not classify unrelated redirects as Access login", () => {
    expect(
      isCloudflareAccessLoginRedirect(
        "https://preview.example.test/app",
        "https://accounts.example.test/login",
      ),
    ).toBe(false);
  });

  it("detects Access without sending the portal bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: {
          Location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/app",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(probePortalAccess("https://preview.example.test/app")).resolves.toEqual({
      access: "cloudflare",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://preview.example.test/app",
      expect.objectContaining({ method: "GET", redirect: "manual" }),
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("openclaw_portal");
  });

  it("falls back when the Gateway cannot reach the browser-facing route", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("DNS unavailable")));
    await expect(probePortalAccess("https://preview.example.test/app")).resolves.toEqual({
      access: "unknown",
    });
  });
});
