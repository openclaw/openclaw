import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { loadUsageResultCached, type UsageCacheEntry } from "./usage-cache.js";

function createSummary(totalTokens = 1) {
  return {
    updatedAt: Date.now(),
    startDate: "2026-02-01",
    endDate: "2026-02-02",
    daily: [],
    totals: {
      totalTokens,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalCost: 0,
    },
  };
}

type Summary = ReturnType<typeof createSummary> & { complete?: boolean };

const loadSummary = vi.fn<() => Promise<Summary>>();
let cache: Map<string, UsageCacheEntry<Summary>>;
let now = 1_000;

describe("usage result cache", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

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

  it("does not grow without bound when (startMs, endMs) varies across day rollover and range switches", async () => {
    const configRef = {};
    const ITERATIONS = 600;
    for (let i = 0; i < ITERATIONS; i++) {
      const startMs = Date.UTC(2026, 0, 1) + i * DAY_MS;
      const endMs = startMs + (i % 3 === 0 ? DAY_MS : 7 * DAY_MS) - 1;
      await loadUsageResultCached({
        cache,
        cacheKey: `${startMs}-${endMs}`,
        configRef,
        load: loadSummary,
      });
    }
    // Observe retained entries as well as lookup behavior; empty-key leaks must fail.
    expect(cache.size).toBeLessThan(ITERATIONS);
    const lastStartMs = Date.UTC(2026, 0, 1) + (ITERATIONS - 1) * DAY_MS;
    const lastEndMs = lastStartMs + ((ITERATIONS - 1) % 3 === 0 ? DAY_MS : 7 * DAY_MS) - 1;
    expect(cache.has(`${lastStartMs}-${lastEndMs}`)).toBe(true);
    const firstStartMs = Date.UTC(2026, 0, 1);
    const firstEndMs = firstStartMs + DAY_MS - 1;
    expect(cache.has(`${firstStartMs}-${firstEndMs}`)).toBe(false);
  });

  it("evicts settled entries before in-flight entries when possible", async () => {
    const configRef = {};
    const pending = createDeferredCore<Summary>();
    loadSummary.mockReturnValueOnce(pending.promise);
    const params = { cache, cacheKey: "active", configRef, load: loadSummary };
    const inFlight = loadUsageResultCached(params);
    let repeated: typeof inFlight | undefined;
    try {
      await Promise.resolve();
      for (let i = 0; i < 256; i++) {
        const startMs = Date.UTC(2026, 0, 1) + i * DAY_MS;
        const endMs = startMs + DAY_MS - 1;
        await loadUsageResultCached({
          cache,
          cacheKey: `${startMs}-${endMs}`,
          configRef,
          load: loadSummary,
        });
      }
      repeated = loadUsageResultCached(params);
      await Promise.resolve();
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
