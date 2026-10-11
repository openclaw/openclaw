import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { createStaleWhileRevalidateCache } from "./stale-while-revalidate-cache.js";

describe("stale-while-revalidate cache", () => {
  let now = 1_000;
  beforeEach(() => {
    now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });
  afterEach(() => vi.restoreAllMocks());

  it("returns expired success immediately while coalescing one background refresh", async () => {
    const cache = createStaleWhileRevalidateCache<string>({ maxEntries: 2, ttlMs: 100 });
    const first = vi.fn(async () => "first");
    await expect(cache.read("item", first)).resolves.toEqual({ value: "first", stale: false });
    expect(first).toHaveBeenCalledWith(false);
    const pending = createDeferredCore<string>();
    const refresh = vi.fn(() => pending.promise);
    await expect(cache.read("item", refresh)).resolves.toEqual({ value: "first", stale: false });
    expect(refresh).not.toHaveBeenCalled();

    now += 100;
    await expect(cache.read("item", refresh)).resolves.toEqual({ value: "first", stale: true });
    await expect(cache.read("item", refresh)).resolves.toEqual({ value: "first", stale: true });
    const waiting = cache.read("item", refresh, { allowStale: false });
    expect(refresh).toHaveBeenCalledExactlyOnceWith(true);
    pending.resolve("second");
    await expect(waiting).resolves.toEqual({ value: "second", stale: false });
    await expect(cache.read("item", refresh)).resolves.toEqual({ value: "second", stale: false });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it.each(["success", "failure"] as const)(
    "bounds superseded loads and keeps the replacement after an older %s",
    async (outcome) => {
      const cache = createStaleWhileRevalidateCache<string>({
        maxEntries: 3,
        maxPending: 2,
        ttlMs: 100,
      });
      const old = createDeferredCore<string>();
      const latest = createDeferredCore<string>();
      const oldRead = cache.read("item", () => old.promise);
      const oldOutcome = oldRead.catch((error: unknown) => error);
      const replace = vi.fn(() => latest.promise);
      const replacement = cache.read("item", replace, { refresh: true });
      expect(replace).toHaveBeenCalledWith(false);
      const overflow = vi.fn(async () => "other");
      await expect(cache.read("other", overflow)).rejects.toThrow("busy");
      expect(overflow).not.toHaveBeenCalled();
      latest.resolve("latest");
      await expect(replacement).resolves.toEqual({ value: "latest", stale: false });
      if (outcome === "success") {
        old.resolve("old");
      } else {
        old.reject(new Error("old failure"));
      }
      await oldOutcome;
      await expect(cache.read("item", overflow)).resolves.toEqual({
        value: "latest",
        stale: false,
      });
      await expect(cache.read("other", overflow)).resolves.toEqual({
        value: "other",
        stale: false,
      });
    },
  );

  it.each(["success", "failure"] as const)(
    "clear fences a pending %s from the replacement cache",
    async (outcome) => {
      const cache = createStaleWhileRevalidateCache<string>({ maxEntries: 2, ttlMs: 100 });
      const old = createDeferredCore<string>();
      const oldRead = cache.read("item", () => old.promise).catch((error: unknown) => error);
      cache.clear();
      await cache.read("item", async () => "replacement");
      if (outcome === "success") {
        old.resolve("old");
      } else {
        old.reject(new Error("old failure"));
      }
      await oldRead;
      const unexpected = vi.fn(async () => "unexpected");
      await expect(cache.read("item", unexpected)).resolves.toEqual({
        value: "replacement",
        stale: false,
      });
      expect(unexpected).not.toHaveBeenCalled();
    },
  );

  it("evicts failed stale data and honors error cooldown before retrying", async () => {
    const onBackgroundError = vi.fn();
    const cache = createStaleWhileRevalidateCache<string>({
      maxEntries: 2,
      ttlMs: 100,
      errorTtlMs: () => 50,
      onBackgroundError,
    });
    await cache.read("item", async () => "first");
    now += 100;
    const failed = createDeferredCore<string>();
    await expect(cache.read("item", () => failed.promise)).resolves.toEqual({
      value: "first",
      stale: true,
    });
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
    await expect(cache.read("item", replacement)).resolves.toEqual({
      value: "recovered",
      stale: false,
    });
    expect(replacement).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("does not retain an expired success after a noncacheable replacement", async () => {
    const cache = createStaleWhileRevalidateCache<number>({
      maxEntries: 2,
      ttlMs: 100,
      cacheable: (value) => value > 0,
    });
    await cache.read("item", async () => 1);
    now += 100;
    const pending = createDeferredCore<number>();
    await expect(cache.read("item", () => pending.promise)).resolves.toEqual({
      value: 1,
      stale: true,
    });
    const replacement = vi.fn(async () => 2);
    const waiting = cache.read("item", replacement, { allowStale: false });
    pending.resolve(0);
    await expect(waiting).resolves.toEqual({ value: 0, stale: false });
    await expect(cache.read("item", replacement)).resolves.toEqual({ value: 2, stale: false });
    expect(replacement).toHaveBeenCalledExactlyOnceWith(false);
  });
});
