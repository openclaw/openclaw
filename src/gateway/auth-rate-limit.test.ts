import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN as DEVICE_TOKEN,
  AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET as SHARED_SECRET,
  buildRateLimitIdentityKey,
  createGatewayAuthRateLimiter,
  isAuthRateLimitClientExempt,
  type RateLimitConfig,
} from "./auth-rate-limit.js";

describe("auth rate limiter", () => {
  let limiter: ReturnType<typeof createGatewayAuthRateLimiter>;
  let clock: ReturnType<typeof createGatewaySchedulerClock>;
  let scheduler: GatewayScheduler;
  beforeEach(() => {
    clock = createGatewaySchedulerClock(1_000);
    scheduler = createTestGatewayScheduler(clock.clock);
  });
  async function advancePenaltyClock(delayMs: number) {
    await clock.advanceBy(delayMs);
    await vi.advanceTimersByTimeAsync(delayMs);
  }
  const baseConfig = { maxAttempts: 2, windowMs: 60_000, lockoutMs: 60_000 };
  const clientIp = "10.0.0.1";
  const check = (scope?: string) => limiter.check(clientIp, scope);
  function fail(count = 1, scope?: string, ip = clientIp) {
    for (let attempt = 0; attempt < count; attempt++) {
      limiter.recordFailure(ip, scope);
    }
  }

  function createLimiter(overrides?: RateLimitConfig, defaults: RateLimitConfig = baseConfig) {
    limiter = createGatewayAuthRateLimiter({ ...defaults, ...overrides }, { scheduler });
  }
  async function expectPenalty(delayMs: number) {
    const pending = limiter.recordFailureAndDelay("127.0.0.1");
    const settled = vi.fn();
    void pending.then(settled);
    await advancePenaltyClock(delayMs - 1);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    await advancePenaltyClock(1);
    await pending;
  }
  afterEach(async () => {
    limiter?.dispose();
    await scheduler.stop();
    vi.useRealTimers();
  });

  it("treats blank scopes as the default scope", () => {
    createLimiter();
    fail(1, "   ");
    fail();
    expect(check().allowed).toBe(false);
    expect(check(" \t ").allowed).toBe(false);
  });

  it("does not extend lockout when failures are recorded while already locked", async () => {
    createLimiter({ lockoutMs: 5_000 });
    fail(2);
    expect(check().allowed).toBe(false);
    const initialRetryAfter = check().retryAfterMs;
    await clock.advanceBy(1_000);
    fail();
    expect(check().retryAfterMs).toBeLessThanOrEqual(initialRetryAfter - 1_000);
  });

  it("applies new limits to retained scope history without releasing earned lockouts", async () => {
    createLimiter({ maxAttempts: 5, windowMs: 10_000, pruneIntervalMs: 0 });
    fail(2, SHARED_SECRET);
    fail(1, DEVICE_TOKEN);

    limiter.updateConfig({ maxAttempts: 2, windowMs: 10_000, lockoutMs: 4_000 });
    expect(check(SHARED_SECRET)).toEqual({ allowed: false, remaining: 0, retryAfterMs: 4_000 });
    expect(check(DEVICE_TOKEN).remaining).toBe(1);

    await clock.advanceBy(1_000);
    limiter.updateConfig({ maxAttempts: 4, windowMs: 10_000, lockoutMs: 9_000 });
    expect(check(SHARED_SECRET).retryAfterMs).toBe(3_000);
    expect(check(DEVICE_TOKEN).remaining).toBe(3);
    fail(3, DEVICE_TOKEN);
    expect(check(DEVICE_TOKEN).retryAfterMs).toBe(9_000);

    await clock.advanceBy(3_000);
    expect(check(SHARED_SECRET)).toEqual({ allowed: true, remaining: 4, retryAfterMs: 0 });
    expect(check(DEVICE_TOKEN).retryAfterMs).toBe(6_000);
  });

  it("replaces window settings and restores omitted defaults without erasing history", async () => {
    createLimiter({ maxAttempts: 5, windowMs: 1_000, exemptLoopback: false, pruneIntervalMs: 0 });
    fail();
    await clock.advanceBy(1_500);

    limiter.updateConfig({ maxAttempts: 3, windowMs: 5_000 });
    expect(check().remaining).toBe(2);
    expect(isAuthRateLimitClientExempt(limiter, "127.0.0.1")).toBe(true);
    limiter.updateConfig({ maxAttempts: 3, windowMs: 1_000 });
    expect(check().remaining).toBe(3);

    fail();
    await clock.advanceBy(1_500);
    limiter.updateConfig();
    expect(check().remaining).toBe(9);
    fail(9);
    expect(check().retryAfterMs).toBe(300_000);
  });

  it("preserves locked entries when flood eviction runs", () => {
    createLimiter({ maxEntries: 3, pruneIntervalMs: 0 });

    fail(2, undefined, "10.0.2.1");
    expect(limiter.check("10.0.2.1").allowed).toBe(false);
    limiter.recordFailure("10.0.2.2");
    limiter.recordFailure("10.0.2.3");

    limiter.recordFailure("10.0.2.4");

    expect(limiter.size()).toBe(3);
    expect(limiter.check("10.0.2.1").allowed).toBe(false);
    expect(limiter.check("10.0.2.2").remaining).toBe(2);
    expect(limiter.check("10.0.2.4").remaining).toBe(1);
  });

  it("preserves overflow and tracked lockouts when policy changes while the table is full", async () => {
    createLimiter({ maxAttempts: 1, maxEntries: 2, pruneIntervalMs: 0 });

    limiter.recordFailure("10.0.3.1");
    limiter.recordFailure("10.0.3.2");
    limiter.recordFailure("10.0.3.3");

    expect(limiter.size()).toBe(2);
    for (const ip of ["10.0.3.1", "10.0.3.2", "10.0.3.3"]) {
      expect(limiter.check(ip)).toMatchObject({ allowed: false });
    }
    expect(limiter.check("10.0.3.3").retryAfterMs).toBeGreaterThan(0);

    await clock.advanceBy(1_000);
    limiter.updateConfig({ maxAttempts: 20, windowMs: 1, lockoutMs: 1 });
    for (const ip of ["10.0.3.1", "10.0.3.2", "10.0.3.3"]) {
      expect(limiter.check(ip)).toEqual({ allowed: false, remaining: 0, retryAfterMs: 59_000 });
    }
    expect(limiter.size()).toBe(2);

    await clock.advanceBy(59_001);
    expect(limiter.check("10.0.3.3").allowed).toBe(true);
  });

  it.each([
    ["1.2.3.4", "::ffff:1.2.3.4", undefined],
    ["browser-origin:http://127.0.0.1:18789", undefined, "browser-origin:http://localhost:5173"],
    [buildRateLimitIdentityKey("node", "node-1"), undefined, undefined],
  ])("throttles %s and its alias", (key, alias, other) => {
    createLimiter({ maxAttempts: 1 });
    limiter.recordFailure(key);
    expect(limiter.check(alias ?? key).allowed).toBe(false);
    if (other) {
      expect(limiter.check(other).allowed).toBe(true);
    }
  });

  it.each([false, true])("caps loopback delay, locked=%s", async (locked) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    createLimiter({ maxAttempts: 1, exemptLoopback: !locked, pruneIntervalMs: 0 });
    const ip = "127.0.0.1";
    if (locked) {
      limiter.recordFailure(ip);
      expect(limiter.check(ip).retryAfterMs).toBe(60_000);
      limiter.updateConfig({ maxAttempts: 1, exemptLoopback: true });
    }
    const firstDelay = locked ? 500 : 250;

    await expectPenalty(firstDelay);
    await expectPenalty(firstDelay * 2);

    fail(100, undefined, ip);
    await expectPenalty(5_000);
    expect(limiter.check(ip).allowed).toBe(true);
    if (locked) {
      limiter.updateConfig({ exemptLoopback: false });
      expect(limiter.check(ip).retryAfterMs).toBe(60_000 - firstDelay * 3 - 5_000);
    }
  });

  it.each([
    [{ maxAttempts: 2, exemptLoopback: true }, 1],
    [{ maxAttempts: 2, exemptLoopback: false }, 1],
    [undefined, 9],
  ] as const)("retires expired locks under %j", async (config, remaining) => {
    createLimiter({ lockoutMs: 1_000, exemptLoopback: false, pruneIntervalMs: 0 });
    const ip = "127.0.0.1";
    fail(2, undefined, ip);
    expect(limiter.check(ip).retryAfterMs).toBe(1_000);

    limiter.updateConfig(config);
    await clock.advanceBy(1_000);
    limiter.recordFailure(ip);
    limiter.updateConfig({ ...config, exemptLoopback: false });

    expect(limiter.check(ip)).toEqual({ allowed: true, remaining, retryAfterMs: 0 });
  });

  it("still delays loopback failures when many are already pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    createLimiter({ pruneIntervalMs: 0 }, {});
    const pending = Array.from({ length: 64 }, (_, index) =>
      limiter.recordFailureAndDelay("127.0.0.1", `scope-${index}`),
    );

    const extraSettled = vi.fn();
    const extra = limiter.recordFailureAndDelay("127.0.0.1", "scope-extra").then(extraSettled);
    await Promise.resolve();
    expect(extraSettled).not.toHaveBeenCalled();
    await advancePenaltyClock(250);
    await extra;
    expect(extraSettled).toHaveBeenCalledOnce();
    limiter.dispose();
    await Promise.all(pending);
  });

  it("preserves earned delay across history reset, policy changes, and scheduler shutdown", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    createLimiter({ maxAttempts: 2, pruneIntervalMs: 0 }, {});
    const settled: string[] = [];
    const first = limiter.recordFailureAndDelay("127.0.0.1", "shared").then(() => {
      settled.push("first");
    });
    const second = limiter.recordFailureAndDelay("127.0.0.1", "shared").then(() => {
      settled.push("second");
    });
    await advancePenaltyClock(100);
    limiter.reset("127.0.0.1", "shared");
    limiter.updateConfig({ maxAttempts: 1, exemptLoopback: false });
    const current = limiter.recordFailureAndDelay("127.0.0.1", "shared");
    expect(limiter.check("127.0.0.1", "shared").allowed).toBe(false);
    await current;
    scheduler.beginClose();
    await advancePenaltyClock(399);
    expect(settled).toEqual([]);

    await advancePenaltyClock(1);
    await Promise.all([first, second]);
    expect(settled).toEqual(["first", "second"]);
  });

  it("reset only clears the requested scope for an IP", () => {
    createLimiter({ maxAttempts: 1 });
    fail(1, SHARED_SECRET);
    fail(1, DEVICE_TOKEN);
    expect(check(SHARED_SECRET).allowed).toBe(false);
    expect(check(DEVICE_TOKEN).allowed).toBe(false);

    limiter.reset(clientIp, SHARED_SECRET);
    expect(check(SHARED_SECRET).allowed).toBe(true);
    expect(check(DEVICE_TOKEN).allowed).toBe(false);
  });

  it.each([5_000, 60_000])("prunes expired locks, window=%s", async (windowMs) => {
    createLimiter({ maxAttempts: 1, windowMs, lockoutMs: 30_000 });
    limiter.recordFailure("10.0.0.31");
    expect(limiter.check("10.0.0.31").allowed).toBe(false);

    await clock.advanceBy(6_000);
    limiter.prune();
    expect(limiter.size()).toBe(1);
    await clock.advanceBy(24_000);
    limiter.prune();
    expect(limiter.size()).toBe(0);
  });

  it("sleeps with no history and resumes pruning without shortening lockouts", async () => {
    createLimiter({ windowMs: 1_000, lockoutMs: 3_000, maxAttempts: 1, pruneIntervalMs: 1_000 });
    expect(scheduler.nextWakeAtMs).toBeNull();

    limiter.recordFailure("10.0.0.35");
    expect(scheduler.nextWakeAtMs).toBe(2_000);
    await clock.advanceBy(1_000);
    expect(limiter.check("10.0.0.35").retryAfterMs).toBe(2_000);
    expect(limiter.size()).toBe(1);

    limiter.reset("10.0.0.35");
    expect(scheduler.nextWakeAtMs).toBeNull();
    limiter.recordFailure("10.0.0.36");
    expect(scheduler.nextWakeAtMs).toBe(3_000);
    await clock.advanceBy(3_000);
    expect(limiter.size()).toBe(0);
    expect(scheduler.nextWakeAtMs).toBeNull();
  });

  it("dispose settles pending loopback failure delays immediately", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    createLimiter({ pruneIntervalMs: 0 }, {});
    const pending = limiter.recordFailureAndDelay("127.0.0.1");

    limiter.dispose();

    await pending;
    scheduler.beginClose();
    await limiter.recordFailureAndDelay("127.0.0.1");
    expect(scheduler.nextWakeAtMs).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
