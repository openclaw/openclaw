import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { createStaleWhileRevalidateCache } from "./stale-while-revalidate-cache.js";

type CacheOptions<T> = Parameters<typeof createStaleWhileRevalidateCache<T>>[0];
const cacheFor = <T>(options: Partial<CacheOptions<T>> = {}) =>
  createStaleWhileRevalidateCache<T>({ maxEntries: 2, ttlMs: 100, ...options });
const fresh = <T>(value: T) => ({ value, stale: false });
const stale = <T>(value: T) => ({ value, stale: true });

let now = 1_000;
beforeEach(() => {
  now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

it("returns expired success immediately while coalescing one background refresh", async () => {
  const cache = cacheFor<string>();
  await expect(cache.read("item", async () => "first")).resolves.toEqual(fresh("first"));
  const pending = createDeferredCore<string>();
  const refresh = vi.fn(() => pending.promise);
  await expect(cache.read("item", refresh)).resolves.toEqual(fresh("first"));
  expect(refresh).not.toHaveBeenCalled();

  now += 100;
  await expect(cache.read("item", refresh)).resolves.toEqual(stale("first"));
  await expect(cache.read("item", refresh)).resolves.toEqual(stale("first"));
  const waiting = cache.read("item", refresh, { allowStale: false });
  expect(refresh).toHaveBeenCalledExactlyOnceWith("first");
  pending.resolve("second");
  await expect(waiting).resolves.toEqual(fresh("second"));
  await expect(cache.read("item", refresh)).resolves.toEqual(fresh("second"));
  expect(refresh).toHaveBeenCalledOnce();
});

it("retires exact cached facts while sharing a replacement load", async () => {
  const cache = cacheFor<{ version: number }>();
  const first = { version: 1 };
  await cache.read("item", async () => first);
  cache.deleteValue(first);
  const pending = createDeferredCore<{ version: number }>();
  const load = vi.fn(() => pending.promise);
  const replacement = cache.read("item", load);
  cache.deleteValue(first);
  const follower = cache.read("item", load);
  const current = { version: 2 };
  pending.resolve(current);
  expect(await replacement).toEqual(fresh(current));
  expect(await follower).toEqual(fresh(current));
  cache.deleteValue(first);
  expect(await cache.read("item", load)).toEqual(fresh(current));
  expect(load).toHaveBeenCalledOnce();
});

it.each([
  ["refresh", "success"],
  ["refresh", "failure"],
  ["clear", "success"],
  ["clear", "failure"],
] as const)("%s keeps its replacement after an older %s", async (mode, outcome) => {
  const refresh = mode === "refresh";
  const cache = cacheFor<string>({ maxEntries: refresh ? 3 : 2, maxPending: 2 });
  const old = createDeferredCore<string>();
  const latest = createDeferredCore<string>();
  const oldOutcome = cache.read("item", () => old.promise).catch((error: unknown) => error);
  if (!refresh) {
    cache.clear();
  }
  const replace = vi.fn(() => latest.promise);
  const replacement = cache.read("item", replace, { refresh });
  expect(replace).toHaveBeenCalledWith(undefined);
  const overflow = vi.fn(async () => "other");
  if (refresh) {
    await expect(cache.read("other", overflow)).rejects.toThrow("busy");
    expect(overflow).not.toHaveBeenCalled();
  }
  latest.resolve("latest");
  await expect(replacement).resolves.toEqual(fresh("latest"));
  if (outcome === "success") {
    old.resolve("old");
  } else {
    old.reject(new Error("old failure"));
  }
  await oldOutcome;
  await expect(cache.read("item", overflow)).resolves.toEqual(fresh("latest"));
  expect(overflow).not.toHaveBeenCalled();
  if (refresh) {
    await expect(cache.read("other", overflow)).resolves.toEqual(fresh("other"));
  }
});

it("evicts failed stale data and honors error cooldown before retrying", async () => {
  const onBackgroundError = vi.fn();
  const cache = cacheFor<string>({ errorTtlMs: () => 50, onBackgroundError });
  await cache.read("item", async () => "first");
  now += 100;
  const failed = createDeferredCore<string>();
  await expect(cache.read("item", () => failed.promise)).resolves.toEqual(stale("first"));
  const replacement = vi.fn(async () => "recovered");
  const waiting = expect(cache.read("item", replacement, { allowStale: false })).rejects.toThrow(
    "offline",
  );
  failed.reject(new Error("offline"));
  await waiting;
  expect(onBackgroundError).toHaveBeenCalledOnce();
  await expect(cache.read("item", replacement)).rejects.toThrow("offline");
  expect(replacement).not.toHaveBeenCalled();
  now += 50;
  await expect(cache.read("item", replacement)).resolves.toEqual(fresh("recovered"));
  expect(replacement).toHaveBeenCalledExactlyOnceWith(undefined);
});

it("does not retain an expired success after a noncacheable replacement", async () => {
  const cache = cacheFor<number>({ cacheable: (value) => value > 0 });
  await cache.read("item", async () => 1);
  now += 100;
  const pending = createDeferredCore<number>();
  await expect(cache.read("item", () => pending.promise)).resolves.toEqual(stale(1));
  const replacement = vi.fn(async () => 2);
  const waiting = cache.read("item", replacement, { allowStale: false });
  pending.resolve(0);
  await expect(waiting).resolves.toEqual(fresh(0));
  await expect(cache.read("item", replacement)).resolves.toEqual(fresh(2));
  expect(replacement).toHaveBeenCalledExactlyOnceWith(undefined);
});
