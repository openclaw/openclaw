import { type Mock, describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
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
    if (retryCount > 0) {
      await vi.advanceTimersByTimeAsync(retryCount * 1000);
    }

    const result = await probePromise;
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(expectedCalls);
    expect(result.bot?.username).toBe("test_bot");
  }

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    global.fetch = withFetchPreconnect(fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    {
      errors: [],
      expectedCalls: 2,
      retryCount: 0,
    },
    {
      errors: ["Network timeout"],
      expectedCalls: 3,
      retryCount: 1,
    },
    {
      errors: ["Network error 1", "Network error 2"],
      expectedCalls: 4,
      retryCount: 2,
    },
  ])("succeeds after retry pattern %#", async ({ errors, expectedCalls, retryCount }) => {
    for (const message of errors) {
      fetchMock.mockRejectedValueOnce(new Error(message));
    }

    mockGetMeSuccess();
    mockGetWebhookInfoSuccess();
    await expectSuccessfulProbe(expectedCalls, retryCount);
  });

  it("should fail after 3 unsuccessful attempts", async () => {
    const errorMsg = "Final network error";
    fetchMock.mockRejectedValue(new Error(errorMsg));

    const probePromise = probeTelegram(token, timeoutMs);

    // Fast-forward for all retries
    await vi.advanceTimersByTimeAsync(2000);

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
