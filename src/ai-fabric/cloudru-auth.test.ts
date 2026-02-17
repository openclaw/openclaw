import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudruTokenProvider, CloudruAuthError } from "./cloudru-auth.js";

function mockFetch(response: { status: number; body?: unknown }): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    json: () => Promise.resolve(response.body),
    text: () => Promise.resolve(JSON.stringify(response.body ?? {})),
  }) as unknown as typeof fetch;
}

const AUTH_CONFIG = { keyId: "test-key-id", secret: "test-secret" };
const IAM_URL = "https://iam.test/token";

describe("CloudruTokenProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exchanges credentials for a token", async () => {
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const fetchImpl = mockFetch({
      status: 200,
      body: { token: "jwt-token-123", expiresAt },
    });

    const provider = new CloudruTokenProvider(AUTH_CONFIG, { iamUrl: IAM_URL, fetchImpl });
    const result = await provider.getToken();

    expect(result.token).toBe("jwt-token-123");
    expect(result.expiresAt).toBe(new Date(expiresAt).getTime());
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns cached token on subsequent calls", async () => {
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const fetchImpl = mockFetch({
      status: 200,
      body: { token: "jwt-cached", expiresAt },
    });

    const provider = new CloudruTokenProvider(AUTH_CONFIG, { iamUrl: IAM_URL, fetchImpl });
    await provider.getToken();
    const second = await provider.getToken();

    expect(second.token).toBe("jwt-cached");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("re-exchanges when token is near expiry", async () => {
    const shortExpiry = new Date(Date.now() + 4 * 60 * 1000).toISOString(); // 4 min — within 5 min margin
    const longExpiry = new Date(Date.now() + 3600_000).toISOString();

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ token: "first", expiresAt: shortExpiry }),
        text: () => Promise.resolve(""),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ token: "refreshed", expiresAt: longExpiry }),
        text: () => Promise.resolve(""),
      }) as unknown as typeof fetch;

    const provider = new CloudruTokenProvider(AUTH_CONFIG, {
      iamUrl: IAM_URL,
      fetchImpl,
      refreshMarginMs: 5 * 60 * 1000,
    });

    const first = await provider.getToken();
    expect(first.token).toBe("first");

    const second = await provider.getToken();
    expect(second.token).toBe("refreshed");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws CloudruAuthError on failed exchange", async () => {
    const fetchImpl = mockFetch({ status: 401, body: { message: "invalid key" } });

    const provider = new CloudruTokenProvider(AUTH_CONFIG, { iamUrl: IAM_URL, fetchImpl });

    await expect(provider.getToken()).rejects.toThrow(CloudruAuthError);
    await expect(provider.getToken()).rejects.toThrow("401");
  });

  it("deduplicates concurrent exchange requests", async () => {
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const fetchImpl = mockFetch({
      status: 200,
      body: { token: "deduped", expiresAt },
    });

    const provider = new CloudruTokenProvider(AUTH_CONFIG, { iamUrl: IAM_URL, fetchImpl });

    const [a, b] = await Promise.all([provider.getToken(), provider.getToken()]);

    expect(a.token).toBe("deduped");
    expect(b.token).toBe("deduped");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("clearCache forces a fresh exchange", async () => {
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ token: "fresh", expiresAt }),
      text: () => Promise.resolve(""),
    }) as unknown as typeof fetch;

    const provider = new CloudruTokenProvider(AUTH_CONFIG, { iamUrl: IAM_URL, fetchImpl });
    await provider.getToken();
    provider.clearCache();
    await provider.getToken();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
