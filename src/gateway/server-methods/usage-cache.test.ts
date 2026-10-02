import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { loadUsageResultCached, type UsageCacheEntry } from "./usage-cache.js";

function createSummary(totalTokens = 1) {
  return { totals: { totalTokens } };
}

type Summary = ReturnType<typeof createSummary> & { complete?: boolean };

const loadSummary = vi.fn<() => Promise<Summary>>();
let cache: Map<string, UsageCacheEntry<Summary>>;
let now = 1_000;

describe("usage result cache", () => {
  beforeEach(() => {
    cache = new Map();
    now = 1_000;
    vi.useRealTimers();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    loadSummary.mockReset().mockResolvedValue(createSummary());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retains a stale refresh after its cache entry is replaced", async () => {
    const owner = new AsyncWorkScope();
    const replacementOwner = new AsyncWorkScope();
    const gate = createDeferredCore<Summary>();
    const params = { cache, cacheKey: "stale", configRef: {}, load: loadSummary };
    const first = await owner.track(() => loadUsageResultCached(params));
    expect(cache.get(params.cacheKey)?.updatedAt).toBe(now);
    now = 31_000;
    loadSummary.mockReturnValueOnce(gate.promise);
    let refresh: Promise<unknown> | undefined;
    let closing: Promise<void> | undefined;
    let drained = false;
    try {
      const stale = await owner.track(() => loadUsageResultCached(params));
      expect(stale).toEqual(first);
      // Keep the exact old tail even when work tracking is the regression under test.
      refresh = cache.get(params.cacheKey)?.inFlight;
      expect(refresh).toBeDefined();
      await replacementOwner.track(() => loadUsageResultCached({ ...params, configRef: {} }));
      await replacementOwner.drain();
      expect(loadSummary).toHaveBeenCalledTimes(3);
      closing = owner.drain().then(() => {
        drained = true;
      });
      await nextTurn();
      expect(drained).toBe(false);
    } finally {
      gate.resolve(createSummary());
      await refresh;
      await closing;
      await Promise.all([owner.drain(), replacementOwner.drain()]);
    }
    expect(drained).toBe(true);
  });

  it("bounds the cache by evicting the oldest settled entry before an in-flight entry", async () => {
    const configRef = {};
    const pending = createDeferredCore<Summary>();
    loadSummary.mockReturnValueOnce(pending.promise);
    const params = { cache, cacheKey: "active", configRef, load: loadSummary };
    const inFlight = loadUsageResultCached(params);
    let repeated: typeof inFlight | undefined;
    try {
      await Promise.resolve();
      for (let i = 0; i < 256; i++) {
        await loadUsageResultCached({
          cache,
          cacheKey: String(i),
          configRef,
          load: loadSummary,
        });
      }
      repeated = loadUsageResultCached(params);
      await Promise.resolve();
      expect(cache.size).toBe(256);
      expect(cache.has("0")).toBe(false);
      expect(cache.has("255")).toBe(true);
      expect(cache.has(params.cacheKey)).toBe(true);
      expect(loadSummary).toHaveBeenCalledTimes(257);
    } finally {
      pending.resolve(createSummary());
      await Promise.all([inFlight, repeated]);
    }
  });

  it("preserves a complete stale result when a refresh is partial", async () => {
    const params = {
      cache,
      cacheKey: "partial",
      configRef: {},
      load: loadSummary,
      isComplete: (summary: Summary) => summary.complete !== false,
    };
    loadSummary.mockResolvedValueOnce(createSummary(10));
    const first = await loadUsageResultCached(params);
    expect(first.totals.totalTokens).toBe(10);
    loadSummary.mockResolvedValueOnce({ ...createSummary(0), complete: false });
    now = 31_000;
    await loadUsageResultCached(params);
    await cache.get(params.cacheKey)?.inFlight;
    expect(cache.get(params.cacheKey)?.inFlight).toBeUndefined();

    const blocked = createDeferredCore<Summary>();
    const started = createDeferredCore();
    loadSummary.mockImplementationOnce(() => {
      started.resolve();
      return blocked.promise;
    });
    let returned = false;
    let next: Promise<Summary> | undefined;
    let refresh: Promise<Summary> | undefined;
    try {
      next = loadUsageResultCached(params).then((result) => {
        returned = true;
        return result;
      });
      refresh = cache.get(params.cacheKey)?.inFlight;
      expect(refresh).toBeDefined();
      await started.promise;
      await Promise.resolve();
      expect(returned).toBe(true);
      expect((await next).totals.totalTokens).toBe(10);
      blocked.resolve(createSummary(20));
      await refresh;
      expect(cache.get(params.cacheKey)?.inFlight).toBeUndefined();
      expect((await loadUsageResultCached(params)).totals.totalTokens).toBe(20);
      expect(loadSummary).toHaveBeenCalledTimes(3);
    } finally {
      blocked.resolve(createSummary(20));
      await Promise.allSettled([next, refresh, blocked.promise]);
    }
  });
});
