// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError } from "../api/gateway.ts";
import { createCanvasSurfaceLease } from "./canvas-surface-lease.runtime.ts";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function observeClock() {
  const scheduled = vi.spyOn(globalThis, "setTimeout");
  return {
    get pendingCount() {
      return vi.getTimerCount();
    },
    get nextDelayMs() {
      return scheduled.mock.calls.at(-1)?.[1];
    },
    takeNextCallback() {
      const call = scheduled.mock.calls.at(-1);
      const timer = scheduled.mock.results.at(-1);
      if (!call || timer?.type !== "return" || typeof call[0] !== "function") {
        throw new Error("Expected a scheduled renewal");
      }
      clearTimeout(timer.value);
      vi.setSystemTime(Date.now() + (call[1] ?? 0));
      return call[0];
    },
    advanceBy: (delayMs: number) => vi.advanceTimersByTimeAsync(delayMs),
  };
}

async function flushPromises() {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

function createLeaseHarness(request: (method: string, params: unknown) => Promise<unknown>) {
  const clock = observeClock();
  const changes: Array<string | null> = [];
  const lease = createCanvasSurfaceLease({
    request,
    onChange: (url) => changes.push(url),
  });
  return { changes, clock, lease };
}

describe("createCanvasSurfaceLease", () => {
  it("stops retrying a forbidden renewal until a new lease starts", async () => {
    const request = vi
      .fn()
      .mockRejectedValue(
        new GatewayRequestError({ code: "FORBIDDEN", message: "missing scope: operator.read" }),
      );
    const { changes, clock, lease } = createLeaseHarness(request);
    const helloUrl = "https://canvas.test/__openclaw__/cap/one";
    lease.start(helloUrl);
    await flushPromises();
    await clock.advanceBy(57 * 60_000);

    expect(request).toHaveBeenCalledOnce();
    expect(clock.pendingCount).toBe(0);
    expect(changes).toEqual([helloUrl]);

    request.mockResolvedValue({
      surface: "canvas",
      pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/reconnected" },
    });
    lease.stop();
    lease.start(helloUrl);
    await flushPromises();
    expect(request).toHaveBeenCalledTimes(2);
    expect(changes.at(-1)).toBe("https://canvas.test/__openclaw__/cap/reconnected");
    expect(clock.pendingCount).toBe(1);
    lease.stop();
  });

  it("seeds from hello, renews immediately, and honors the refreshed expiry", async () => {
    const request = vi
      .fn<(method: string, params: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce({
        surface: "canvas",
        pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/two" },
        expiresAtMs: 200_000,
      })
      .mockResolvedValueOnce({
        surface: "canvas",
        pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/three" },
      });
    const { changes, clock, lease } = createLeaseHarness(request);
    const helloUrl = "https://canvas.test/__openclaw__/cap/one";

    lease.start(helloUrl);
    expect(changes).toEqual([helloUrl]);
    expect(request).not.toHaveBeenCalled();
    await flushPromises();

    expect(request).toHaveBeenCalledWith("plugin.surface.refresh", {
      surface: "canvas",
      observedUrl: helloUrl,
    });
    expect(changes.at(-1)).toBe("https://canvas.test/__openclaw__/cap/two");
    expect(clock.nextDelayMs).toBe(85_000);

    await clock.advanceBy(85_000);
    expect(changes.at(-1)).toBe("https://canvas.test/__openclaw__/cap/three");
    expect(clock.nextDelayMs).toBe(60_000);
  });

  it("keeps overlapping renewals single-flight", async () => {
    const pending = deferred<unknown>();
    const request = vi
      .fn<(method: string, params: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce({
        surface: "canvas",
        pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/two" },
        expiresAtMs: 116_000,
      })
      .mockImplementation(() => pending.promise);
    const { clock, lease } = createLeaseHarness(request);
    lease.start("https://canvas.test/__openclaw__/cap/one");
    await flushPromises();

    const callback = clock.takeNextCallback();
    expect(callback).toBeDefined();
    callback?.();
    callback?.();
    await flushPromises();
    expect(request).toHaveBeenCalledTimes(2);

    pending.resolve({
      surface: "canvas",
      pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/two" },
    });
    await flushPromises();
    expect(clock.pendingCount).toBe(1);
  });

  it("keeps retrying past three failures, caps its backoff, and recovers", async () => {
    let failuresRemaining = 10;
    const request = vi.fn<(method: string, params: unknown) => Promise<unknown>>(async () => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error("refresh failed");
      }
      return {
        surface: "canvas",
        pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/fresh" },
      };
    });
    const { changes, clock, lease } = createLeaseHarness(request);
    const originalUrl = "https://canvas.test/__openclaw__/cap/one";
    lease.start(originalUrl);

    await flushPromises();
    const backoffs = [
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000,
    ];
    for (const delayMs of backoffs) {
      expect(clock.nextDelayMs).toBe(delayMs);
      await clock.advanceBy(delayMs);
    }

    expect(request).toHaveBeenCalledTimes(11);
    expect(changes.at(-1)).toBe("https://canvas.test/__openclaw__/cap/fresh");
    expect(clock.nextDelayMs).toBe(60_000);
  });

  it.each(["stops", "reconnects without a canvas"] as const)(
    "does not schedule a retired generation when publishing a refreshed URL %s",
    async (transition) => {
      const clock = observeClock();
      const changes: Array<string | null> = [];
      const request = vi.fn(async () => ({
        surface: "canvas",
        pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/refreshed" },
        expiresAtMs: 120_000,
      }));
      const lease = createCanvasSurfaceLease({
        request,
        onChange: (url) => {
          changes.push(url);
          if (url === "https://canvas.test/__openclaw__/cap/refreshed") {
            if (transition === "stops") {
              lease.stop();
            } else {
              lease.start(undefined);
            }
          }
        },
      });

      lease.start("https://canvas.test/__openclaw__/cap/original");
      await flushPromises();

      expect(request).toHaveBeenCalledOnce();
      expect(changes).toEqual([
        "https://canvas.test/__openclaw__/cap/original",
        "https://canvas.test/__openclaw__/cap/refreshed",
        null,
      ]);
      expect(clock.pendingCount).toBe(0);
    },
  );

  it("keeps the reconnect renewal owned when a retired timer callback arrives late", async () => {
    const request = vi
      .fn<(method: string, params: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce({
        surface: "canvas",
        pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/first" },
        expiresAtMs: 120_000,
      })
      .mockResolvedValueOnce({
        surface: "canvas",
        pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/reconnected" },
        expiresAtMs: 180_000,
      });
    const { clock, lease } = createLeaseHarness(request);

    lease.start("https://canvas.test/__openclaw__/cap/original");
    await flushPromises();
    const retiredCallback = clock.takeNextCallback();
    expect(retiredCallback).toBeDefined();

    lease.stop();
    lease.start("https://canvas.test/__openclaw__/cap/reconnect");
    await flushPromises();
    expect(clock.pendingCount).toBe(1);

    retiredCallback?.();
    expect(request).toHaveBeenCalledTimes(2);
    lease.stop();

    expect(clock.pendingCount).toBe(0);
  });

  it.each([Number.MAX_SAFE_INTEGER, 2 ** 32 + 115_000])(
    "clamps an advertised canvas expiry of %d to a browser-safe native timer",
    async (expiresAtMs) => {
      const request = vi.fn(async () => ({
        surface: "canvas",
        pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/refreshed" },
        expiresAtMs,
      }));
      const { clock, lease } = createLeaseHarness(request);

      lease.start("https://canvas.test/__openclaw__/cap/original");
      await flushPromises();

      expect(clock.nextDelayMs).toBe(2_147_483_647);
      lease.stop();
    },
  );

  it("stop clears timers, ignores an in-flight result, and publishes null once", async () => {
    const pending = deferred<unknown>();
    const { changes, clock, lease } = createLeaseHarness(() => pending.promise);
    lease.start("https://canvas.test/__openclaw__/cap/one");
    await flushPromises();

    lease.stop();
    lease.stop();
    expect(clock.pendingCount).toBe(0);
    expect(changes).toEqual(["https://canvas.test/__openclaw__/cap/one", null]);

    pending.resolve({
      surface: "canvas",
      pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/two" },
    });
    await flushPromises();
    expect(changes).toEqual(["https://canvas.test/__openclaw__/cap/one", null]);
  });
});
