import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
// Auth rate-limit tests cover sliding-window, lockout, scope, loopback, and
// cleanup behavior shared by gateway secret and device-token authentication.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
  AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
  buildRateLimitIdentityKey,
  createGatewayAuthRateLimiter,
  isAuthRateLimitClientExempt,
} from "./auth-rate-limit.js";

describe("auth rate limiter", () => {
  let limiter: ReturnType<typeof createGatewayAuthRateLimiter>;
  let clock: ReturnType<typeof createGatewaySchedulerClock>;
  let scheduler: GatewayScheduler;
  beforeEach(() => {
    clock = createGatewaySchedulerClock(1_000);
    scheduler = createTestGatewayScheduler(clock.clock);
  });
  function createClockedAuthRateLimiter(
    config?: Parameters<typeof createGatewayAuthRateLimiter>[0],
  ) {
    return createGatewayAuthRateLimiter(config, { scheduler });
  }
  async function advancePenaltyClock(delayMs: number) {
    await clock.advanceBy(delayMs);
    await vi.advanceTimersByTimeAsync(delayMs);
  }
  const baseConfig = { maxAttempts: 2, windowMs: 60_000, lockoutMs: 60_000 };

  function createLimiter(
    overrides?: Partial<{
      maxAttempts: number;
      windowMs: number;
      lockoutMs: number;
      exemptLoopback: boolean;
      pruneIntervalMs: number;
      maxEntries: number;
    }>,
  ) {
    limiter = createClockedAuthRateLimiter({
      ...baseConfig,
      ...overrides,
    });
    return limiter;
  }

  afterEach(async () => {
    limiter?.dispose();
    await scheduler.stop();
    vi.useRealTimers();
  });

  it("treats blank scopes as the default scope", () => {
    createLimiter();
    limiter.recordFailure("10.0.0.8", "   ");
    limiter.recordFailure("10.0.0.8");
    expect(limiter.check("10.0.0.8").allowed).toBe(false);
    expect(limiter.check("10.0.0.8", " \t ").allowed).toBe(false);
  });

  it("does not extend lockout when failures are recorded while already locked", async () => {
    createLimiter({ lockoutMs: 5_000 });
    limiter.recordFailure("10.0.0.33");
    limiter.recordFailure("10.0.0.33");
    const locked = limiter.check("10.0.0.33");
    expect(locked.allowed).toBe(false);
    const initialRetryAfter = locked.retryAfterMs;

    await clock.advanceBy(1_000);
    limiter.recordFailure("10.0.0.33");
    const afterExtraFailure = limiter.check("10.0.0.33");
    expect(afterExtraFailure.retryAfterMs).toBeLessThanOrEqual(initialRetryAfter - 1_000);
  });

  it("clamps oversized lockout durations", () => {
    limiter = createClockedAuthRateLimiter({
      maxAttempts: 1,
      windowMs: 60_000,
      lockoutMs: Number.MAX_SAFE_INTEGER,
    });

    limiter.recordFailure("10.0.0.34");

    expect(limiter.check("10.0.0.34").retryAfterMs).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("applies new limits to retained scope history without releasing earned lockouts", async () => {
    createLimiter({ maxAttempts: 5, windowMs: 10_000, pruneIntervalMs: 0 });
    const ip = "10.0.0.5";
    limiter.recordFailure(ip, AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET);
    limiter.recordFailure(ip, AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET);
    limiter.recordFailure(ip, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);

    limiter.updateConfig({ maxAttempts: 2, windowMs: 10_000, lockoutMs: 4_000 });
    expect(limiter.check(ip, AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET)).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterMs: 4_000,
    });
    expect(limiter.check(ip, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN).remaining).toBe(1);

    await clock.advanceBy(1_000);
    limiter.updateConfig({ maxAttempts: 4, windowMs: 10_000, lockoutMs: 9_000 });
    expect(limiter.check(ip, AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET).retryAfterMs).toBe(3_000);
    expect(limiter.check(ip, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN).remaining).toBe(3);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      limiter.recordFailure(ip, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
    }
    expect(limiter.check(ip, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN).retryAfterMs).toBe(9_000);

    await clock.advanceBy(3_000);
    expect(limiter.check(ip, AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET)).toEqual({
      allowed: true,
      remaining: 4,
      retryAfterMs: 0,
    });
    expect(limiter.check(ip, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN).retryAfterMs).toBe(6_000);
  });

  it("replaces window settings and restores omitted defaults without erasing history", async () => {
    createLimiter({
      maxAttempts: 5,
      windowMs: 1_000,
      exemptLoopback: false,
      pruneIntervalMs: 0,
    });
    const ip = "10.0.0.6";
    limiter.recordFailure(ip);
    await clock.advanceBy(1_500);

    limiter.updateConfig({ maxAttempts: 3, windowMs: 5_000 });
    expect(limiter.check(ip).remaining).toBe(2);
    expect(isAuthRateLimitClientExempt(limiter, "127.0.0.1")).toBe(true);
    limiter.updateConfig({ maxAttempts: 3, windowMs: 1_000 });
    expect(limiter.check(ip).remaining).toBe(3);

    limiter.recordFailure(ip);
    await clock.advanceBy(1_500);
    limiter.updateConfig();
    expect(limiter.check(ip).remaining).toBe(9);
    for (let attempt = 0; attempt < 9; attempt += 1) {
      limiter.recordFailure(ip);
    }
    expect(limiter.check(ip).retryAfterMs).toBe(300_000);
  });

  it("preserves locked entries when flood eviction runs", () => {
    createLimiter({ maxEntries: 3, pruneIntervalMs: 0 });

    limiter.recordFailure("10.0.2.1");
    limiter.recordFailure("10.0.2.1");
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
    limiter = createClockedAuthRateLimiter({
      maxAttempts: 1,
      windowMs: 60_000,
      lockoutMs: 60_000,
      maxEntries: 2,
      pruneIntervalMs: 0,
    });

    limiter.recordFailure("10.0.3.1");
    limiter.recordFailure("10.0.3.2");
    limiter.recordFailure("10.0.3.3");

    expect(limiter.size()).toBe(2);
    expect(limiter.check("10.0.3.1").allowed).toBe(false);
    expect(limiter.check("10.0.3.2").allowed).toBe(false);
    const overflowResult = limiter.check("10.0.3.3");
    expect(overflowResult.allowed).toBe(false);
    expect(overflowResult.retryAfterMs).toBeGreaterThan(0);

    await clock.advanceBy(1_000);
    limiter.updateConfig({ maxAttempts: 20, windowMs: 1, lockoutMs: 1 });
    for (const ip of ["10.0.3.1", "10.0.3.2", "10.0.3.3"]) {
      expect(limiter.check(ip)).toEqual({
        allowed: false,
        remaining: 0,
        retryAfterMs: 59_000,
      });
    }
    expect(limiter.size()).toBe(2);

    await clock.advanceBy(59_001);
    expect(limiter.check("10.0.3.3").allowed).toBe(true);
  });

  it("treats ipv4 and ipv4-mapped ipv6 forms as the same client", () => {
    limiter = createClockedAuthRateLimiter({ maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000 });
    limiter.recordFailure("1.2.3.4");
    expect(limiter.check("::ffff:1.2.3.4").allowed).toBe(false);
  });

  it("tracks synthetic browser-origin limiter keys independently", () => {
    limiter = createClockedAuthRateLimiter({ maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000 });
    limiter.recordFailure("browser-origin:http://127.0.0.1:18789");
    expect(limiter.check("browser-origin:http://127.0.0.1:18789").allowed).toBe(false);
    expect(limiter.check("browser-origin:http://localhost:5173").allowed).toBe(true);
  });

  // ---------- loopback exemption ----------

  it.each(["127.0.0.1", "::1"])("exempts loopback address %s by default", (ip) => {
    limiter = createClockedAuthRateLimiter({ maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000 });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      limiter.recordFailure(ip);
    }
    expect(limiter.check(ip).allowed).toBe(true);
  });

  it.each([false, true])(
    "escalates and caps loopback delay with an existing lockout: %s",
    async (locked) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      limiter = createClockedAuthRateLimiter({
        maxAttempts: 1,
        windowMs: 60_000,
        lockoutMs: 60_000,
        exemptLoopback: !locked,
        pruneIntervalMs: 0,
      });
      const ip = "127.0.0.1";
      if (locked) {
        limiter.recordFailure(ip);
        expect(limiter.check(ip).retryAfterMs).toBe(60_000);
        limiter.updateConfig({ maxAttempts: 1, exemptLoopback: true });
      }
      const firstDelay = locked ? 500 : 250;

      const first = limiter.recordFailureAndDelay(ip);
      await advancePenaltyClock(firstDelay - 1);
      let settled = false;
      void first.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      await advancePenaltyClock(1);
      await first;

      const second = limiter.recordFailureAndDelay(ip);
      await advancePenaltyClock(firstDelay * 2 - 1);
      settled = false;
      void second.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      await advancePenaltyClock(1);
      await second;

      for (let attempt = 0; attempt < 100; attempt += 1) {
        limiter.recordFailure(ip);
      }
      const capped = limiter.recordFailureAndDelay(ip);
      await advancePenaltyClock(4_999);
      settled = false;
      void capped.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      await advancePenaltyClock(1);
      await capped;
      expect(limiter.check(ip).allowed).toBe(true);
      if (locked) {
        limiter.updateConfig({ exemptLoopback: false });
        expect(limiter.check(ip).retryAfterMs).toBe(60_000 - firstDelay * 3 - 5_000);
      }
    },
  );

  it.each([
    { policy: "exempt", config: { maxAttempts: 2, exemptLoopback: true }, remaining: 1 },
    { policy: "nonexempt", config: { maxAttempts: 2, exemptLoopback: false }, remaining: 1 },
    { policy: "default", config: undefined, remaining: 9 },
  ])(
    "retires expired locks before counting fresh $policy failures",
    async ({ config, remaining }) => {
      createLimiter({ lockoutMs: 1_000, exemptLoopback: false, pruneIntervalMs: 0 });
      const ip = "127.0.0.1";
      limiter.recordFailure(ip);
      limiter.recordFailure(ip);
      expect(limiter.check(ip).retryAfterMs).toBe(1_000);

      limiter.updateConfig(config);
      await clock.advanceBy(1_000);
      limiter.recordFailure(ip);
      limiter.updateConfig({ ...config, exemptLoopback: false });

      expect(limiter.check(ip)).toEqual({ allowed: true, remaining, retryAfterMs: 0 });
    },
  );

  it("reset clears the loopback penalty history", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    limiter = createClockedAuthRateLimiter({ pruneIntervalMs: 0 });
    limiter.recordFailure("127.0.0.1");
    limiter.recordFailure("127.0.0.1");
    limiter.reset("127.0.0.1");

    const delayed = limiter.recordFailureAndDelay("127.0.0.1");
    await advancePenaltyClock(249);
    let settled = false;
    void delayed.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await advancePenaltyClock(1);
    await delayed;
  });

  // Regression: an earlier revision skipped the delay once a global timer cap was
  // full, so an attacker could park cheap failures in every slot and then guess
  // without penalty. Concurrency must never buy a faster answer than one attempt.
  it("still delays loopback failures when many are already pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    limiter = createClockedAuthRateLimiter({ pruneIntervalMs: 0 });
    const pending = Array.from({ length: 64 }, (_, index) =>
      limiter.recordFailureAndDelay("127.0.0.1", `scope-${index}`),
    );

    let extraSettled = false;
    const extra = limiter.recordFailureAndDelay("127.0.0.1", "scope-extra").then(() => {
      extraSettled = true;
    });
    await Promise.resolve();
    expect(extraSettled).toBe(false);

    await advancePenaltyClock(250);
    await extra;
    expect(extraSettled).toBe(true);

    limiter.dispose();
    await Promise.all(pending);
  });

  // Parallel guesses on one key share the key's deadline instead of each starting
  // a fresh short timer, so fanning out cannot outrun the escalating penalty.
  it("preserves earned delay across history reset, policy changes, and scheduler shutdown", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    limiter = createClockedAuthRateLimiter({ maxAttempts: 2, pruneIntervalMs: 0 });
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

  it("reports the authoritative exemption policy for fallback serialization", () => {
    limiter = createClockedAuthRateLimiter({ maxAttempts: 1 });
    expect(isAuthRateLimitClientExempt(limiter, "127.0.0.1")).toBe(true);
    expect(isAuthRateLimitClientExempt(limiter, buildRateLimitIdentityKey("node", "node-1"))).toBe(
      false,
    );
    limiter.recordFailure("127.0.0.1");
    limiter.updateConfig({ maxAttempts: 1, exemptLoopback: false });
    expect(isAuthRateLimitClientExempt(limiter, "127.0.0.1")).toBe(false);
    expect(limiter.check("127.0.0.1").allowed).toBe(false);
    limiter.updateConfig();
    expect(isAuthRateLimitClientExempt(limiter, "127.0.0.1")).toBe(true);
    expect(limiter.check("127.0.0.1").allowed).toBe(true);
    limiter.updateConfig({ exemptLoopback: false });
    expect(limiter.check("127.0.0.1").allowed).toBe(false);
  });

  it("does not exempt opaque identity keys", () => {
    limiter = createClockedAuthRateLimiter({ maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000 });
    const key = buildRateLimitIdentityKey("node", "node-1");
    limiter.recordFailure(key);
    expect(limiter.check(key).allowed).toBe(false);
  });

  it("reset only clears the requested scope for an IP", () => {
    limiter = createClockedAuthRateLimiter({ maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000 });
    limiter.recordFailure("10.0.0.21", AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET);
    limiter.recordFailure("10.0.0.21", AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
    expect(limiter.check("10.0.0.21", AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET).allowed).toBe(false);
    expect(limiter.check("10.0.0.21", AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN).allowed).toBe(false);

    limiter.reset("10.0.0.21", AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET);
    expect(limiter.check("10.0.0.21", AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET).allowed).toBe(true);
    expect(limiter.check("10.0.0.21", AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN).allowed).toBe(false);
  });

  it.each([5_000, 60_000])(
    "prune retires expired lock histories with a %sms window",
    async (windowMs) => {
      limiter = createClockedAuthRateLimiter({ maxAttempts: 1, windowMs, lockoutMs: 30_000 });
      limiter.recordFailure("10.0.0.31");
      expect(limiter.check("10.0.0.31").allowed).toBe(false);

      await clock.advanceBy(6_000);
      limiter.prune();
      expect(limiter.size()).toBe(1); // Still locked-out, not pruned.
      await clock.advanceBy(24_000);
      limiter.prune();
      expect(limiter.size()).toBe(0);
    },
  );

  it("clamps oversized positive auto-prune intervals", async () => {
    limiter = createClockedAuthRateLimiter({ pruneIntervalMs: Number.MAX_SAFE_INTEGER });

    limiter.recordFailure("10.0.0.32");
    await clock.advanceBy(MAX_TIMER_TIMEOUT_MS - 1);
    expect(limiter.size()).toBe(1);
    await clock.advanceBy(1);
    expect(limiter.size()).toBe(0);
  });

  // ---------- undefined / empty IP ----------

  it("normalizes undefined IP to 'unknown'", () => {
    createLimiter();
    limiter.recordFailure(undefined);
    limiter.recordFailure(undefined);
    expect(limiter.check(undefined).allowed).toBe(false);
    expect(limiter.size()).toBe(1);
  });

  it("dispose settles pending loopback failure delays immediately", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    limiter = createClockedAuthRateLimiter({ pruneIntervalMs: 0 });
    const pending = limiter.recordFailureAndDelay("127.0.0.1");

    limiter.dispose();

    await pending;
    scheduler.beginClose();
    await limiter.recordFailureAndDelay("127.0.0.1");
    expect(scheduler.nextWakeAtMs).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
