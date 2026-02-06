import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { probeTelegram } from "./probe.js";

describe("probeTelegram retry logic", () => {
  const token = "test-token";
  const timeoutMs = 5000;

  beforeEach(() => {
    vi.useFakeTimers();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("should succeed if the first attempt succeeds", async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        ok: true,
        result: { id: 123, username: "test_bot" },
      }),
    };
    (global.fetch as any).mockResolvedValueOnce(mockResponse);

    // Mock getWebhookInfo which is also called
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true, result: { url: "" } }),
    });

    const result = await probeTelegram(token, timeoutMs);

    expect(result.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2); // getMe + getWebhookInfo
    expect(result.bot?.username).toBe("test_bot");
  });

  it("should retry and succeed if first attempt fails but second succeeds", async () => {
    // 1st attempt: Network error
    (global.fetch as any).mockRejectedValueOnce(new Error("Network timeout"));

    // 2nd attempt: Success
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        ok: true,
        result: { id: 123, username: "test_bot" },
      }),
    });

    // getWebhookInfo
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true, result: { url: "" } }),
    });

    const probePromise = probeTelegram(token, timeoutMs);

    // Fast-forward 1 second for the retry delay
    await vi.advanceTimersByTimeAsync(1000);

    const result = await probePromise;

    expect(result.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(3); // fail getMe, success getMe, getWebhookInfo
    expect(result.bot?.username).toBe("test_bot");
  });

  it("should retry twice and succeed on the third attempt", async () => {
    // 1st attempt: Network error
    (global.fetch as any).mockRejectedValueOnce(new Error("Network error 1"));
    // 2nd attempt: Network error
    (global.fetch as any).mockRejectedValueOnce(new Error("Network error 2"));

    // 3rd attempt: Success
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        ok: true,
        result: { id: 123, username: "test_bot" },
      }),
    });

    // getWebhookInfo
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true, result: { url: "" } }),
    });

    const probePromise = probeTelegram(token, timeoutMs);

    // Fast-forward for two retries
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    const result = await probePromise;

    expect(result.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(4); // fail, fail, success, webhook
    expect(result.bot?.username).toBe("test_bot");
  });

  it("should fail after 3 unsuccessful attempts", async () => {
    const errorMsg = "Final network error";
    (global.fetch as any).mockRejectedValue(new Error(errorMsg));

    const probePromise = probeTelegram(token, timeoutMs);

    // Fast-forward for all retries
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    const result = await probePromise;

    expect(result.ok).toBe(false);
    expect(result.error).toBe(errorMsg);
    expect(global.fetch).toHaveBeenCalledTimes(3); // 3 attempts at getMe
  });

  it("should NOT retry if getMe returns a 401 Unauthorized", async () => {
    const mockResponse = {
      ok: false,
      status: 401,
      json: vi.fn().mockResolvedValue({
        ok: false,
        description: "Unauthorized",
      }),
    };
    (global.fetch as any).mockResolvedValueOnce(mockResponse);

    const result = await probeTelegram(token, timeoutMs);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toBe("Unauthorized");
    expect(global.fetch).toHaveBeenCalledTimes(1); // Should not retry
  });
});
