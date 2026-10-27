import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { loadUsageResultCached, type UsageCacheEntry } from "./usage-cache.js";

const summary = (totalTokens = 1) => ({ totals: { totalTokens } });
type Summary = ReturnType<typeof summary> & { complete?: boolean };
type Query = Parameters<typeof loadUsageResultCached<Summary>>[0];
const loader = vi.fn<() => Promise<Summary>>();
let cache: Map<string, UsageCacheEntry<Summary>>;
let configRef: object;
let now: number;
const work: Promise<unknown>[] = [];
const releases: (() => void)[] = [];
const owners: AsyncWorkScope[] = [];
function query(cacheKey = "all-sessions", overrides: Partial<Query> = {}): Query {
  return { cache, cacheKey, configRef, revision: 0, load: loader, ...overrides };
}

function load(params: Query) {
  const result = loadUsageResultCached(params);
  work.push(result);
  const flight = cache.get(params.cacheKey)?.inFlight;
  if (flight) {
    work.push(flight);
  }
  return result;
}
function blocked(totalTokens = 1) {
  const pending = createDeferredCore<Summary>();
  releases.push(() => pending.resolve(summary(totalTokens)));
  return pending;
}
function owner() {
  const scope = new AsyncWorkScope();
  owners.push(scope);
  return scope;
}
beforeEach(() => {
  cache = new Map();
  configRef = {};
  now = 1_000;
  vi.useRealTimers();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  loader.mockReset().mockResolvedValue(summary());
});
afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  await Promise.allSettled(work.splice(0));
  await Promise.all(owners.splice(0).map((scope) => scope.drain()));
  vi.restoreAllMocks();
});

it.each([false, true])(
  "replaces revisions without retaining history (revisionOnly=%s)",
  async (revisionOnly) => {
    const revisions = revisionOnly ? 2 : 32;
    for (let revision = 1; revision <= revisions; revision++) {
      loader.mockResolvedValueOnce(summary(revision));
      const params = query("overview", { revision, revisionOnly });
      const result = await load(params);
      expect(result.totals.totalTokens).toBe(revision);
      expect(cache.size).toBe(1);
      if (revisionOnly && revision === 1) {
        now += 60_000;
        expect(await load(params)).toBe(result);
        expect(loader).toHaveBeenCalledTimes(1);
      }
    }
    expect(loader).toHaveBeenCalledTimes(revisions);
  },
);

it("does not let a displaced revision overwrite the current result", async () => {
  const pending = blocked();
  loader.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(summary(2));
  const old = load(query("all-sessions", { revision: 1 }));
  const current = query("all-sessions", { revision: 2 });
  const latest = load(current);
  pending.resolve(summary());
  expect((await latest).totals.totalTokens).toBe(2);
  expect((await old).totals.totalTokens).toBe(1);
  expect((await load(current)).totals.totalTokens).toBe(2);
  expect(cache.size).toBe(1);
  expect(loader).toHaveBeenCalledTimes(2);
});

it.each([true, false])(
  "reclaims expired variants before the count cap (complete=%s)",
  async (complete) => {
    for (let index = 0; index < 32; index++) {
      await load(query(`date-range-${index}`, { isComplete: () => complete }));
      expect(cache.size).toBe(1);
      now += 30_001;
    }
    expect(loader).toHaveBeenCalledTimes(32);
  },
);

it("retains a stale refresh after its cache entry is replaced", async () => {
  const original = owner(),
    replacement = owner();
  const gate = blocked();
  const params = query("stale");
  const first = await original.track(() => load(params));
  expect(cache.get(params.cacheKey)?.updatedAt).toBe(now);
  now = 31_000;
  loader.mockReturnValueOnce(gate.promise);
  expect(await original.track(() => load(params))).toEqual(first);
  const refresh = cache.get(params.cacheKey)?.inFlight;
  expect(refresh).toBeDefined();
  await replacement.track(() => load({ ...params, configRef: {} }));
  await replacement.drain();
  expect(loader).toHaveBeenCalledTimes(3);
  let drained = false;
  const closing = original.drain().then(() => {
    drained = true;
  });
  await nextTurn();
  expect(drained).toBe(false);
  gate.resolve(summary());
  await refresh;
  await closing;
  expect(drained).toBe(true);
});

it("evicts the oldest settled entry before an in-flight entry", async () => {
  const pending = blocked();
  loader.mockReturnValueOnce(pending.promise);
  const params = query("active");
  const active = load(params);
  await Promise.resolve();
  now += 30_001;
  for (let i = 0; i < 256; i++) {
    await load(query(String(i)));
  }
  const retained = load(params);
  await Promise.resolve();
  expect(cache.size).toBe(256);
  expect(cache.has("0")).toBe(false);
  expect(cache.has("255")).toBe(true);
  expect(cache.has(params.cacheKey)).toBe(true);
  expect(loader).toHaveBeenCalledTimes(257);
  pending.resolve(summary());
  await Promise.all([active, retained]);
});

it("preserves a complete stale result when a refresh is partial", async () => {
  const params = query("partial", { isComplete: (value) => value.complete !== false });
  loader.mockResolvedValueOnce(summary(10));
  expect((await load(params)).totals.totalTokens).toBe(10);
  loader.mockResolvedValueOnce({ ...summary(0), complete: false });
  now = 31_000;
  await load(params);
  await cache.get(params.cacheKey)?.inFlight;
  expect(cache.get(params.cacheKey)?.inFlight).toBeUndefined();
  const pending = blocked(20),
    started = createDeferredCore();
  loader.mockImplementationOnce(() => {
    started.resolve();
    return pending.promise;
  });
  let returned = false;
  const next = load(params).then((result) => {
    returned = true;
    return result;
  });
  const refresh = cache.get(params.cacheKey)?.inFlight;
  expect(refresh).toBeDefined();
  await started.promise;
  await Promise.resolve();
  expect(returned).toBe(true);
  expect((await next).totals.totalTokens).toBe(10);
  pending.resolve(summary(20));
  await refresh;
  expect(cache.get(params.cacheKey)?.inFlight).toBeUndefined();
  expect((await load(params)).totals.totalTokens).toBe(20);
  expect(loader).toHaveBeenCalledTimes(3);
});
