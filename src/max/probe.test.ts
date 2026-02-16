import { beforeEach, describe, expect, it, vi } from "vitest";
import { probeMax } from "./probe.js";

// Mock fetchWithTimeout to intercept all HTTP calls
const fetchWithTimeoutMock = vi.fn();
vi.mock("../utils/fetch-timeout.js", () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchWithTimeoutMock(...args),
}));

// Suppress proxy import side effects
vi.mock("../telegram/proxy.js", () => ({
  makeProxyFetch: vi.fn(() => vi.fn()),
}));

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

describe("probeMax", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchWithTimeoutMock.mockReset();
    return () => {
      vi.useRealTimers();
    };
  });

  it("returns ok=true with bot info on successful /me response", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      jsonResponse({ user_id: 42, name: "TestBot", username: "test_bot", is_bot: true }),
    );

    const result = await probeMax("test-token", 5000);

    expect(result.ok).toBe(true);
    expect(result.bot).toEqual({ id: 42, name: "TestBot", username: "test_bot" });
    expect(result.error).toBeNull();
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);

    // Verify correct URL and headers
    const [url, init] = fetchWithTimeoutMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://platform-api.max.ru/me");
    expect((init.headers as Record<string, string>).Authorization).toBe("test-token");
  });

  it("sends raw token without Bot prefix", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      jsonResponse({ user_id: 1, name: "Bot", username: "bot" }),
    );

    await probeMax("raw-token-123", 5000);

    const [, init] = fetchWithTimeoutMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("raw-token-123");
  });

  it("returns ok=false on non-200 response", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ message: "Unauthorized" }, 401));

    const result = await probeMax("bad-token", 5000);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toBe("Unauthorized");
  });

  it("returns ok=false with generic error on non-200 without message field", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ code: "forbidden" }, 403));

    const result = await probeMax("bad-token", 5000);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.error).toContain("getMe failed (403)");
  });

  it("retries up to 3 times on network error", async () => {
    fetchWithTimeoutMock
      .mockRejectedValueOnce(new Error("Connection refused"))
      .mockRejectedValueOnce(new Error("Timeout"))
      .mockResolvedValueOnce(
        jsonResponse({ user_id: 99, name: "RetryBot", username: "retry_bot" }),
      );

    const resultPromise = probeMax("token", 5000);

    // Advance through retry delays (2 x 1000ms)
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    const result = await resultPromise;

    expect(result.ok).toBe(true);
    expect(result.bot?.username).toBe("retry_bot");
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(3);
  });

  it("returns error after all 3 retries fail", async () => {
    fetchWithTimeoutMock
      .mockRejectedValueOnce(new Error("fail1"))
      .mockRejectedValueOnce(new Error("fail2"))
      .mockRejectedValueOnce(new Error("fail3"));

    const resultPromise = probeMax("token", 5000);

    // Advance through retry delays
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    const result = await resultPromise;

    expect(result.ok).toBe(false);
    expect(result.error).toBe("fail3");
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(3);
  });

  it("records elapsedMs", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      jsonResponse({ user_id: 1, name: "Bot", username: "bot" }),
    );

    const result = await probeMax("token", 5000);

    expect(typeof result.elapsedMs).toBe("number");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("handles null fields in /me response gracefully", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      jsonResponse({ user_id: null, name: null, username: null }),
    );

    const result = await probeMax("token", 5000);

    expect(result.ok).toBe(true);
    expect(result.bot).toEqual({ id: null, name: null, username: null });
  });

  it("handles missing fields in /me response gracefully", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({}));

    const result = await probeMax("token", 5000);

    expect(result.ok).toBe(true);
    expect(result.bot).toEqual({ id: null, name: null, username: null });
  });
});
