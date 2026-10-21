import { expect, it } from "vitest";
import {
  createBoundedCounter,
  createFixedWindowRateLimiter,
  createWebhookAnomalyTracker,
  WEBHOOK_ANOMALY_COUNTER_DEFAULTS,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
} from "./webhook-memory-guards.js";

function loggedTracker(options: Parameters<typeof createWebhookAnomalyTracker>[0]) {
  const logs: string[] = [];
  const tracker = createWebhookAnomalyTracker(options);
  const record = (key = "k", statusCode = 401, label = "hit") =>
    tracker.record({ key, statusCode, message: (n) => `${label}:${n}`, log: (m) => logs.push(m) });
  return { logs, record };
}

it("createFixedWindowRateLimiter falls back for non-finite options", () => {
  const limiter = createFixedWindowRateLimiter({
    windowMs: Number.NaN,
    maxRequests: Number.NaN,
    maxTrackedKeys: Number.NaN,
    pruneIntervalMs: Number.NaN,
  });

  for (let index = 0; index < WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests; index += 1) {
    expect(limiter.isRateLimited("k", 1_000 + index)).toBe(false);
  }
  expect(limiter.isRateLimited("k", 2_000)).toBe(true);
});

it("createFixedWindowRateLimiter resets counters after the window elapses", () => {
  const limiter = createFixedWindowRateLimiter({
    windowMs: 10,
    maxRequests: 1,
    maxTrackedKeys: 100,
  });

  expect([100, 101, 111].map((nowMs) => limiter.isRateLimited("k", nowMs))).toEqual([
    false,
    true,
    false,
  ]);
});

it("createFixedWindowRateLimiter caps tracked keys", () => {
  const limiter = createFixedWindowRateLimiter({
    windowMs: 60_000,
    maxRequests: 10,
    maxTrackedKeys: 5,
  });

  for (let i = 0; i < 20; i += 1) {
    limiter.isRateLimited(`key-${i}`, 1_000 + i);
  }

  expect(limiter.size()).toBeLessThanOrEqual(5);
});

it("createBoundedCounter increments and returns per-key counts", () => {
  const counter = createBoundedCounter({ maxTrackedKeys: 100 });

  expect([1_000, 1_001, 1_002].map((nowMs) => counter.increment("k", nowMs))).toEqual([1, 2, 3]);
});

it("createBoundedCounter expires stale keys when ttl is set", () => {
  const counter = createBoundedCounter({
    maxTrackedKeys: 100,
    ttlMs: 10,
    pruneIntervalMs: 10,
  });

  counter.increment("old-1", 100);
  counter.increment("old-2", 100);
  expect(counter.size()).toBe(2);

  counter.increment("fresh", 120);
  expect(counter.size()).toBe(1);
});

it("ignores untracked statuses and empty keys and logs tracked events at configured cadence", () => {
  const { logs, record } = loggedTracker({ trackedStatusCodes: [401], logEvery: 2 });
  const counts = [
    record("k", 415, "ignored"),
    record("", 401, "ignored"),
    record("k", 401, "hit"),
    record("k", 401, "hit"),
  ];

  expect(counts).toEqual([0, 0, 1, 2]);
  expect(logs).toEqual(["hit:1", "hit:2"]);
});

it("falls back for non-finite anomaly logging cadence", () => {
  const { logs, record } = loggedTracker({ logEvery: Number.NaN });

  for (let index = 0; index < WEBHOOK_ANOMALY_COUNTER_DEFAULTS.logEvery; index += 1) {
    record();
  }

  expect(logs).toEqual(["hit:1", `hit:${WEBHOOK_ANOMALY_COUNTER_DEFAULTS.logEvery}`]);
});
