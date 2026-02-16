import { type Mock, describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { probeTelegram } from "./probe.js";

describe("probeTelegram retry logic", () => {
  const token = "test-token";
  const timeoutMs = 5000;
  let fetchMock: Mock;

  function mockGetMeSuccess() {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        ok: true,
        result: { id: 123, username: "test_bot" },
      }),
    });
  }

  function mockGetWebhookInfoSuccess() {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true, result: { url: "" } }),
    });
  }

  async function expectSuccessfulProbe(expectedCalls: number, retryCount = 0) {
    const probePromise = probeTelegram(token, timeoutMs);
    for (let i = 0; i < retryCount; i += 1) {
      await vi.advanceTimersByTimeAsync(1000);
    }

    const result = await probePromise;
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(expectedCalls);
    expect(result.bot?.username).toBe("test_bot");
  }

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("should succeed if the first attempt succeeds", async () => {
    mockGetMeSuccess();
    mockGetWebhookInfoSuccess();
    await expectSuccessfulProbe(2);
  });

  it("should retry and succeed if first attempt fails but second succeeds", async () => {
    // 1st attempt: Network error
    fetchMock.mockRejectedValueOnce(new Error("Network timeout"));

    mockGetMeSuccess();
    mockGetWebhookInfoSuccess();
    await expectSuccessfulProbe(3, 1);
  });

  it("should retry twice and succeed on the third attempt", async () => {
    // 1st attempt: Network error
    fetchMock.mockRejectedValueOnce(new Error("Network error 1"));
    // 2nd attempt: Network error
    fetchMock.mockRejectedValueOnce(new Error("Network error 2"));

    mockGetMeSuccess();
    mockGetWebhookInfoSuccess();
    await expectSuccessfulProbe(4, 2);
  });

  it("should fail after 3 unsuccessful attempts", async () => {
    const errorMsg = "Final network error";
    fetchMock.mockRejectedValue(new Error(errorMsg));

    const probePromise = probeTelegram(token, timeoutMs);

    // Fast-forward for all retries
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    const result = await probePromise;

    expect(result.ok).toBe(false);
    expect(result.error).toBe(errorMsg);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 3 attempts at getMe
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
    fetchMock.mockResolvedValueOnce(mockResponse);

    const result = await probeTelegram(token, timeoutMs);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toBe("Unauthorized");
    expect(fetchMock).toHaveBeenCalledTimes(1); // Should not retry
  });
});
