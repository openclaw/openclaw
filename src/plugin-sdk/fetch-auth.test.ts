import { describe, expect, it, vi } from "vitest";
import { fetchWithBearerAuthScopeFallback } from "./fetch-auth.js";

const asFetch = (fn: unknown): typeof fetch => fn as typeof fetch;

describe("fetchWithBearerAuthScopeFallback", () => {
  it("rejects non-https urls when https is required", async () => {
    await expect(
      fetchWithBearerAuthScopeFallback({
        url: "http://example.com/file",
        scopes: [],
        requireHttps: true,
      }),
    ).rejects.toThrow("URL must use HTTPS");
  });

  it("returns immediately when the first attempt succeeds", async () => {
    const fetchFn = vi.fn(async () => new Response("ok", { status: 200 }));
    const tokenProvider = { getAccessToken: vi.fn(async () => "unused") };

    const response = await fetchWithBearerAuthScopeFallback({
      url: "https://example.com/file",
      scopes: ["https://graph.microsoft.com"],
      fetchFn: asFetch(fetchFn),
      tokenProvider,
    });

    expect(response.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(tokenProvider.getAccessToken).not.toHaveBeenCalled();
  });

  it("retries with auth scopes after a 401 response", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const tokenProvider = { getAccessToken: vi.fn(async () => "token-1") };

    const response = await fetchWithBearerAuthScopeFallback({
      url: "https://graph.microsoft.com/v1.0/me",
      scopes: ["https://graph.microsoft.com", "https://api.botframework.com"],
      fetchFn: asFetch(fetchFn),
      tokenProvider,
    });

    expect(response.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(tokenProvider.getAccessToken).toHaveBeenCalledWith("https://graph.microsoft.com");
    const secondCall = fetchFn.mock.calls[1] as [string, RequestInit | undefined];
    const secondHeaders = new Headers(secondCall[1]?.headers);
    expect(secondHeaders.get("authorization")).toBe("Bearer token-1");
  });

  it("does not attach auth when host predicate rejects url", async () => {
    const fetchFn = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    const tokenProvider = { getAccessToken: vi.fn(async () => "token-1") };

    const response = await fetchWithBearerAuthScopeFallback({
      url: "https://example.com/file",
      scopes: ["https://graph.microsoft.com"],
      fetchFn: asFetch(fetchFn),
      tokenProvider,
      shouldAttachAuth: () => false,
    });

    expect(response.status).toBe(401);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(tokenProvider.getAccessToken).not.toHaveBeenCalled();
  });

  it("continues across scopes when token retrieval fails", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const tokenProvider = {
      getAccessToken: vi
        .fn()
        .mockRejectedValueOnce(new Error("first scope failed"))
        .mockResolvedValueOnce("token-2"),
    };

    const response = await fetchWithBearerAuthScopeFallback({
      url: "https://graph.microsoft.com/v1.0/me",
      scopes: ["https://first.example", "https://second.example"],
      fetchFn: asFetch(fetchFn),
      tokenProvider,
    });

    expect(response.status).toBe(200);
    expect(tokenProvider.getAccessToken).toHaveBeenCalledTimes(2);
    expect(tokenProvider.getAccessToken).toHaveBeenNthCalledWith(1, "https://first.example");
    expect(tokenProvider.getAccessToken).toHaveBeenNthCalledWith(2, "https://second.example");
  });
});
