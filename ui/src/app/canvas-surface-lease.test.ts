// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError } from "../api/gateway.ts";
import { createCanvasSurfaceLease } from "./canvas-surface-lease.runtime.ts";

const url = (name: string) => `https://canvas.test/__openclaw__/cap/${name}`;
const helloUrl = url("one");
type Request = (method: string, params: unknown) => Promise<unknown>;
let request: ReturnType<typeof vi.fn<Request>>;
let clock: ReturnType<typeof observeClock>;
let changes: Array<string | null>;
let lease: ReturnType<typeof createCanvasSurfaceLease>;
let onChange: (url: string | null) => void;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  request = vi.fn<Request>();
  clock = observeClock();
  changes = [];
  onChange = () => {};
  lease = createCanvasSurfaceLease({
    request,
    onChange: (changed) => {
      changes.push(changed);
      onChange(changed);
    },
  });
});

afterEach(() => {
  lease.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const observeClock = () => vi.spyOn(globalThis, "setTimeout");
const nextDelay = () => clock.mock.calls.at(-1)?.[1];
function takeNextCallback() {
  const call = clock.mock.calls.at(-1);
  const timer = clock.mock.results.at(-1);
  if (!call || timer?.type !== "return" || typeof call[0] !== "function") {
    throw new Error("Expected a scheduled renewal");
  }
  clearTimeout(timer.value);
  vi.setSystemTime(Date.now() + (call[1] ?? 0));
  return call[0];
}

async function flushPromises() {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

const refreshed = (name: string, expiresAtMs?: number) => ({
  surface: "canvas",
  pluginSurfaceUrls: { canvas: url(name) },
  expiresAtMs,
});
const respond = (...responses: ReturnType<typeof refreshed>[]) =>
  responses.forEach((response) => request.mockResolvedValueOnce(response));
async function start(name = "one") {
  lease.start(url(name));
  await flushPromises();
}

it("stops retrying a forbidden renewal until a new lease starts", async () => {
  request.mockRejectedValue(
    new GatewayRequestError({ code: "FORBIDDEN", message: "missing scope: operator.read" }),
  );
  await start();
  await vi.advanceTimersByTimeAsync(57 * 60_000);
  expect(request).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  expect(changes).toEqual([helloUrl]);
  request.mockResolvedValue(refreshed("reconnected"));
  lease.stop();
  await start();
  expect(request).toHaveBeenCalledTimes(2);
  expect(changes.at(-1)).toBe(url("reconnected"));
  expect(vi.getTimerCount()).toBe(1);
});

it("seeds from hello, renews immediately, and honors the refreshed expiry", async () => {
  respond(refreshed("two", 200_000), refreshed("three"));
  lease.start(helloUrl);
  expect(changes).toEqual([helloUrl]);
  expect(request).not.toHaveBeenCalled();
  await flushPromises();
  expect(changes.at(-1)).toBe(url("two"));
  expect(nextDelay()).toBe(85_000);
  await vi.advanceTimersByTimeAsync(85_000);
  expect(changes.at(-1)).toBe(url("three"));
  expect(nextDelay()).toBe(60_000);
});

it("keeps overlapping renewals single-flight", async () => {
  const pending = deferred<unknown>();
  respond(refreshed("two", 116_000));
  request.mockImplementation(() => pending.promise);
  await start("one");
  const callback = takeNextCallback();
  callback();
  callback();
  await flushPromises();
  expect(request).toHaveBeenCalledTimes(2);
  pending.resolve(refreshed("two"));
  await flushPromises();
  expect(vi.getTimerCount()).toBe(1);
});

it("keeps retrying past three failures, caps its backoff, and recovers", async () => {
  request.mockResolvedValue(refreshed("fresh"));
  for (let attempt = 0; attempt < 10; attempt++) {
    request.mockRejectedValueOnce(new Error("refresh failed"));
  }
  await start();
  const backoffs = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000];
  for (const delayMs of backoffs) {
    expect(nextDelay()).toBe(delayMs);
    await vi.advanceTimersByTimeAsync(delayMs);
  }
  expect(request).toHaveBeenCalledTimes(11);
  expect(changes.at(-1)).toBe(url("fresh"));
  expect(nextDelay()).toBe(60_000);
});

it.each(["stops", "reconnects without a canvas"] as const)(
  "does not schedule a retired generation when publishing a refreshed URL %s",
  async (transition) => {
    respond(refreshed("refreshed", 120_000));
    onChange = (changed) => {
      if (changed === url("refreshed")) {
        return transition === "stops" ? lease.stop() : lease.start(undefined);
      }
    };
    await start("original");
    expect(request).toHaveBeenCalledOnce();
    expect(changes).toEqual([url("original"), url("refreshed"), null]);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("keeps the reconnect renewal owned when a retired timer callback arrives late", async () => {
  respond(refreshed("first", 120_000), refreshed("reconnected", 180_000));
  await start("original");
  const retiredCallback = takeNextCallback();
  lease.stop();
  await start("reconnect");
  expect(vi.getTimerCount()).toBe(1);
  retiredCallback();
  expect(request).toHaveBeenCalledTimes(2);
  lease.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it("clamps an advertised canvas expiry to a browser-safe native timer", async () => {
  respond(refreshed("refreshed", Number.MAX_SAFE_INTEGER));
  await start("original");
  expect(nextDelay()).toBe(2_147_483_647);
});

it("stop clears timers, ignores an in-flight result, and publishes null once", async () => {
  const pending = deferred<unknown>();
  request.mockImplementation(() => pending.promise);
  await start("one");
  lease.stop();
  lease.stop();
  expect(vi.getTimerCount()).toBe(0);
  expect(changes).toEqual([helloUrl, null]);
  pending.resolve(refreshed("two"));
  await flushPromises();
  expect(changes).toEqual([helloUrl, null]);
});
