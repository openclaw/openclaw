import assert from "node:assert/strict";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withProviderCatalogDiscoveryBudget } from "../plugins/provider-catalog-expiry.js";
import { clearLiveCatalogCacheForTests } from "../plugins/provider-live-catalog-cache.js";
import {
  fetchLiveProviderModelRows,
  getCachedLiveProviderModelRows,
  type CachedLiveProviderModelRowsParams,
  type LiveModelCatalogFetchGuard,
} from "./provider-catalog-live-acquisition.internal.js";

let now = 100;
const fetchGuard = vi.fn<LiveModelCatalogFetchGuard>();
const request = {
  providerId: "secret-provider-marker",
  endpoint: "https://secret-origin.example.test/v1/models",
  apiKey: "secret-key-marker",
  fetchGuard,
};

beforeEach(() => {
  now = 100;
  clearLiveCatalogCacheForTests();
  fetchGuard.mockReset();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(Date, "now").mockReturnValue(1_000_000);
});
afterEach(() => {
  clearLiveCatalogCacheForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function rejection(pending: Promise<unknown>) {
  try {
    await pending;
  } catch (error) {
    assert(error instanceof Error);
    expect(error.message).toContain("model discovery exceeded");
    expect(fetchGuard).not.toHaveBeenCalled();
    return error;
  }
  throw new Error("Expected unchanged pre-GET deadline rejection");
}

function delayedKey(value: string, at: number) {
  return {
    toJSON() {
      now = at;
      return value;
    },
  };
}

function read(options: Partial<CachedLiveProviderModelRowsParams> = {}) {
  return getCachedLiveProviderModelRows({ ...request, ...options });
}

it("distinguishes an already-expired parent from a fresh child exhausted in cache entry", async () => {
  const inherited = await withProviderCatalogDiscoveryBudget(5_000, async () => {
    now = 5_200;
    return await rejection(read());
  });
  expect(inherited.cause).toMatchObject({
    kind: "catalog_budget_origin_v1",
    parent: { present: true, timeoutMs: 5_000, deadlineMs: 5_100, originKnown: true },
    child: { constructionNow: 5_200, deadlineMs: 5_100 },
    acquisition: { now: 5_200, derivedTimeoutMs: -100 },
    guard: { remainingTimeoutMs: -100, pageIndex: 0 },
  });
  now = 100;
  const exhausted = await rejection(read({ cacheKeyParts: [delayedKey("fresh", 5_200)] }));
  expect(exhausted.cause).toMatchObject({
    parent: { present: false, originKnown: true },
    child: { constructionNow: 100, deadlineMs: 5_100, wallNow: 1_000_000 },
    cache: { entryNow: 100, loadNow: 5_200, ttlWallNow: 1_000_000, disposition: "new-load" },
    binding: {
      sameLoad: true,
      sameBudget: true,
      sameOwner: true,
      sameClockObject: true,
      sameNowFunction: true,
    },
  });
  const serialized = JSON.stringify(exhausted.cause);
  expect(serialized.length).toBeLessThan(2_500);
  for (const secret of [request.providerId, request.endpoint, request.apiKey, "fresh"]) {
    expect(serialized).not.toContain(secret);
  }
});

it("keeps the producing origin when a fresh caller joins its pending cache load", async () => {
  const producer = rejection(read({ cacheKeyParts: [delayedKey("shared", 5_200)] }));
  now = 200;
  const joiner = rejection(read({ cacheKeyParts: ["shared"] }));
  const [first, second] = await Promise.all([producer, joiner]);
  expect(second).toBe(first);
  expect(second.cause).toMatchObject({
    child: { constructionNow: 100, deadlineMs: 5_100 },
    cache: { entryNow: 100, loadNow: 5_200 },
    binding: { sameLoad: true, sameBudget: true },
  });
});

it("keeps concurrent acquisitions distinct without storing cache keys", async () => {
  const first = rejection(read({ cacheKeyParts: [delayedKey("secret-first-key", 5_200)] }));
  now = 200;
  const second = rejection(read({ cacheKeyParts: [delayedKey("secret-second-key", 5_400)] }));
  const [one, two] = await Promise.all([first, second]);
  expect(one.cause).not.toBe(two.cause);
  expect(one.cause).toMatchObject({
    child: { constructionNow: 100 },
    acquisition: { derivedTimeoutMs: -100 },
  });
  expect(two.cause).toMatchObject({
    child: { constructionNow: 200 },
    acquisition: { derivedTimeoutMs: -200 },
  });
  expect(JSON.stringify([one.cause, two.cause])).not.toContain("secret-");
});

it("reports changed clock identity instead of asserting a common monotonic origin", async () => {
  const timeOrigin = performance.timeOrigin;
  const key = {
    toJSON() {
      vi.stubGlobal("performance", { now: () => 5_200, timeOrigin: timeOrigin + 1 });
      return "clock-change";
    },
  };
  const error = await rejection(read({ cacheKeyParts: [key] }));
  expect(error.cause).toMatchObject({
    binding: {
      sameLoad: true,
      sameBudget: true,
      sameClockObject: false,
      sameNowFunction: false,
      timeOrigins: [timeOrigin, timeOrigin, timeOrigin + 1, timeOrigin + 1, timeOrigin + 1],
    },
  });
});

it("marks absent provenance unknown and encodes unbounded parent values explicitly", async () => {
  const direct = await rejection(fetchLiveProviderModelRows({ ...request, timeoutMs: -1 }));
  expect(direct.cause).toMatchObject({
    parent: { present: "unknown", originKnown: false },
    child: { constructionNow: "unknown" },
    cache: { disposition: "unknown" },
    binding: { sameLoad: "unknown", sameBudget: "unknown", sameClockObject: "unknown" },
  });
  const unbounded = await withProviderCatalogDiscoveryBudget(null, () =>
    rejection(read({ timeoutMs: 0, ttlMs: 0 })),
  );
  expect(unbounded.cause).toMatchObject({
    parent: {
      present: true,
      timeoutMs: "unbounded",
      deadlineMs: "positive_infinity",
      originKnown: true,
    },
    child: { effectiveTimeoutMs: 0, deadlineMs: 100 },
    cache: { disposition: "uncached" },
    guard: { remainingTimeoutMs: 0 },
  });
});

it("binds the actual budget owner across duplicated SDK-module loading", async () => {
  await withProviderCatalogDiscoveryBudget(5_000, async () => {
    vi.resetModules();
    const duplicate = await import("./provider-catalog-live-acquisition.internal.js");
    now = 5_200;
    const error = await rejection(duplicate.getCachedLiveProviderModelRows(request));
    expect(error.cause).toMatchObject({
      parent: { present: true, originKnown: true },
      binding: { sameOwner: true, sameLoad: true, sameBudget: true, sameClockObject: true },
    });
  });
});
