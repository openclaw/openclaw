import { describe, expect, it, vi } from "vitest";
import { retryClawHubRead } from "./clawhub-retry.js";

describe("retryClawHubRead", () => {
  it("honors Retry-After and cancels the discarded response", async () => {
    const cancel = vi.fn();
    const delays: number[] = [];
    let attempts = 0;

    const result = await retryClawHubRead(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          return {
            response: new Response(
              new ReadableStream<Uint8Array>({
                cancel() {
                  cancel();
                },
              }),
              {
                status: 503,
                headers: { "Retry-After": "1" },
              },
            ),
          };
        }
        return { response: new Response("ok") };
      },
      {
        disposeRetry: async ({ response }) => {
          await response.body?.cancel();
        },
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    expect(await result.response.text()).toBe("ok");
    expect(attempts).toBe(2);
    expect(delays).toEqual([1_000]);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("retries transport failures with the bounded schedule", async () => {
    const delays: number[] = [];
    let attempts = 0;

    const result = await retryClawHubRead(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new TypeError("fetch failed");
        }
        return { response: new Response("ok") };
      },
      {
        disposeRetry: async () => {},
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    expect(await result.response.text()).toBe("ok");
    expect(attempts).toBe(2);
    expect(delays).toEqual([1_000]);
  });

  it.each([
    { name: "fractional seconds", retryAfter: "0.5", expectedDelayMs: 1_000 },
    {
      name: "normalized invalid HTTP date",
      retryAfter: "Sun, 31 Feb 2027 00:00:00 GMT",
      expectedDelayMs: 1_000,
    },
  ])("uses the bounded fallback for $name", async ({ retryAfter, expectedDelayMs }) => {
    const delays: number[] = [];
    let attempts = 0;
    await retryClawHubRead(
      async () => ({
        response: new Response(attempts++ === 0 ? "retry" : "ok", {
          status: attempts === 1 ? 503 : 200,
          headers: attempts === 1 ? { "Retry-After": retryAfter } : undefined,
        }),
      }),
      {
        disposeRetry: async ({ response }) => {
          await response.body?.cancel();
        },
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    expect(delays).toEqual([expectedDelayMs]);
  });

  it("honors a strict IMF-fixdate within the retry cap", async () => {
    const now = Date.UTC(2027, 0, 1, 0, 0, 0);
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
    const delays: number[] = [];
    let attempts = 0;
    try {
      await retryClawHubRead(
        async () => ({
          response: new Response(attempts++ === 0 ? "retry" : "ok", {
            status: attempts === 1 ? 503 : 200,
            headers:
              attempts === 1 ? { "Retry-After": new Date(now + 5_000).toUTCString() } : undefined,
          }),
        }),
        {
          disposeRetry: async ({ response }) => {
            await response.body?.cancel();
          },
          sleep: async (ms) => {
            delays.push(ms);
          },
        },
      );
    } finally {
      dateNow.mockRestore();
    }

    expect(delays).toEqual([5_000]);
  });

  it("does not retry 429 unless the caller enables rate-limit retries", async () => {
    let defaultAttempts = 0;
    const defaultResult = await retryClawHubRead(
      async () => {
        defaultAttempts += 1;
        return { response: new Response("limited", { status: 429 }) };
      },
      {
        disposeRetry: async () => {},
        sleep: async () => {},
      },
    );

    let optedInAttempts = 0;
    const optedInResult = await retryClawHubRead(
      async () => {
        optedInAttempts += 1;
        return {
          response: new Response(optedInAttempts === 1 ? "limited" : "ok", {
            status: optedInAttempts === 1 ? 429 : 200,
          }),
        };
      },
      {
        disposeRetry: async ({ response }) => {
          await response.body?.cancel();
        },
        retryRateLimit: true,
        sleep: async () => {},
      },
    );

    expect(defaultResult.response.status).toBe(429);
    expect(defaultAttempts).toBe(1);
    expect(await optedInResult.response.text()).toBe("ok");
    expect(optedInAttempts).toBe(2);
  });
});
