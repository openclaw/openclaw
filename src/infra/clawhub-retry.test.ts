import { expect, it, vi } from "vitest";
import { retryClawHubRead } from "./clawhub-retry.js";

function retryResponse(first: Response | Error, retryRateLimit = false) {
  const delays: number[] = [];
  const request = vi.fn(async () => ({ response: new Response("ok") }));
  request.mockImplementationOnce(async () => {
    if (first instanceof Error) {
      throw first;
    }
    return { response: first };
  });
  const result = retryClawHubRead(request, {
    retryRateLimit,
    disposeRetry: async ({ response }) => {
      await response.body?.cancel();
    },
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  return { result, request, delays };
}

it("ignores fractional Retry-After delay-seconds values", async () => {
  const { result, delays } = retryResponse(
    new Response("limited", {
      status: 503,
      headers: { "Retry-After": "1.5" },
    }),
  );
  expect(await (await result).response.text()).toBe("ok");
  expect(delays).toEqual([1_000]);
});

it("honors a valid HTTP-date Retry-After through the shared parser", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2027-03-02T23:59:30.000Z"));
  try {
    const { result, delays } = retryResponse(
      new Response("limited", {
        status: 503,
        headers: { "Retry-After": "Tue, 02 Mar 2027 23:59:35 GMT" },
      }),
    );
    expect(await (await result).response.text()).toBe("ok");
    expect(delays).toEqual([5_000]);
  } finally {
    vi.useRealTimers();
  }
});

it("does not retry permanent certificate failures", async () => {
  const failure = new TypeError("fetch failed", { cause: { code: "CERT_HAS_EXPIRED" } });
  const { result, request, delays } = retryResponse(failure);
  await expect(result).rejects.toBe(failure);
  expect(request).toHaveBeenCalledTimes(1);
  expect(delays).toEqual([]);
});

it("does not retry 429 unless the caller enables rate-limit retries", async () => {
  const defaults = retryResponse(new Response("limited", { status: 429 }));
  expect((await defaults.result).response.status).toBe(429);
  expect(defaults.request).toHaveBeenCalledTimes(1);
  const optedIn = retryResponse(new Response("limited", { status: 429 }), true);
  expect(await (await optedIn.result).response.text()).toBe("ok");
  expect(optedIn.request).toHaveBeenCalledTimes(2);
});
