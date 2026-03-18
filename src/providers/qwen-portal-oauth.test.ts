import { describe, expect, it, vi, afterEach } from "vitest";
import { refreshQwenPortalCredentials } from "./qwen-portal-oauth.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
});

describe("refreshQwenPortalCredentials", () => {
  const expiredCredentials = () => ({
    access: "old-access",
    refresh: "old-refresh",
    expires: Date.now() - 1000,
  });

  const runRefresh = async () => await refreshQwenPortalCredentials(expiredCredentials());

  const stubFetchResponse = (response: unknown) => {
    const fetchSpy = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchSpy);
    return fetchSpy;
  };

  it("refreshes tokens with a new access token", async () => {
    const fetchSpy = stubFetchResponse({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      }),
    });

    const result = await runRefresh();

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://chat.qwen.ai/api/v1/oauth2/token",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(result.access).toBe("new-access");
    expect(result.refresh).toBe("new-refresh");
    expect(result.expires).toBeGreaterThan(Date.now());
  });

  it("keeps refresh token when refresh response omits it", async () => {
    stubFetchResponse({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-access",
        expires_in: 1800,
      }),
    });

    const result = await runRefresh();

    expect(result.refresh).toBe("old-refresh");
  });

  it("keeps refresh token when response sends an empty refresh token", async () => {
    stubFetchResponse({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "",
        expires_in: 1800,
      }),
    });

    const result = await runRefresh();

    expect(result.refresh).toBe("old-refresh");
  });

  it("errors when refresh response has invalid expires_in", async () => {
    stubFetchResponse({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 0,
      }),
    });

    await expect(runRefresh()).rejects.toThrow(
      "Qwen OAuth refresh response missing or invalid expires_in",
    );
  });

  it("errors when refresh token is invalid", async () => {
    stubFetchResponse({
      ok: false,
      status: 400,
      text: async () => "invalid_grant",
    });

    await expect(runRefresh()).rejects.toThrow("Qwen OAuth refresh token expired or invalid");
  });

  it("errors when refresh token is missing before any request", async () => {
    await expect(
      refreshQwenPortalCredentials({
        access: "old-access",
        refresh: "   ",
        expires: Date.now() - 1000,
      }),
    ).rejects.toThrow("Qwen OAuth refresh token missing");
  });

  it("errors when refresh response omits access token", async () => {
    stubFetchResponse({
      ok: true,
      status: 200,
      json: async () => ({
        refresh_token: "new-refresh",
        expires_in: 1800,
      }),
    });

    await expect(runRefresh()).rejects.toThrow("Qwen OAuth refresh response missing access token");
  });

  it("errors with server payload text for non-400 status", async () => {
    stubFetchResponse({
      ok: false,
      status: 500,
      statusText: "Server Error",
      text: async () => "gateway down",
    });

    await expect(runRefresh()).rejects.toThrow("Qwen OAuth refresh failed: gateway down");
  });
});
