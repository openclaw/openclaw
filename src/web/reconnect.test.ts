import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  computeBackoff,
  DEFAULT_HEARTBEAT_SECONDS,
  DEFAULT_RECONNECT_POLICY,
  DEFAULT_TIER1_POLICY,
  DEFAULT_TIER2_POLICY,
  DEFAULT_TIER3_POLICY,
  getTierPolicy,
  resolveHeartbeatSeconds,
  resolveReconnectPolicy,
  resolveTieredPolicy,
  sleepWithAbort,
} from "./reconnect.js";

describe("web reconnect helpers", () => {
  const cfg: OpenClawConfig = {};

  it("resolves sane reconnect defaults with clamps", () => {
    const policy = resolveReconnectPolicy(cfg, {
      initialMs: 100,
      maxMs: 5,
      factor: 20,
      jitter: 2,
      maxAttempts: -1,
    });

    expect(policy.initialMs).toBe(250); // clamped to minimum
    expect(policy.maxMs).toBeGreaterThanOrEqual(policy.initialMs);
    expect(policy.factor).toBeLessThanOrEqual(10);
    expect(policy.jitter).toBeLessThanOrEqual(1);
    expect(policy.maxAttempts).toBeGreaterThanOrEqual(0);
  });

  it("computes increasing backoff with jitter", () => {
    const policy = { ...DEFAULT_RECONNECT_POLICY, jitter: 0 };
    const first = computeBackoff(policy, 1);
    const second = computeBackoff(policy, 2);
    expect(first).toBe(policy.initialMs);
    expect(second).toBeGreaterThan(first);
    expect(second).toBeLessThanOrEqual(policy.maxMs);
  });

  it("returns heartbeat default when unset", () => {
    expect(resolveHeartbeatSeconds(cfg)).toBe(DEFAULT_HEARTBEAT_SECONDS);
    expect(resolveHeartbeatSeconds(cfg, 5)).toBe(5);
  });

  it("sleepWithAbort rejects on abort", async () => {
    const controller = new AbortController();
    const promise = sleepWithAbort(50, controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow("aborted");
  });

  describe("tiered reconnect policy", () => {
    it("returns default tiers when no config provided", () => {
      const tiered = resolveTieredPolicy(cfg);
      expect(tiered.tier1.maxAttempts).toBe(DEFAULT_TIER1_POLICY.maxAttempts);
      expect(tiered.tier2.maxAttempts).toBe(DEFAULT_TIER2_POLICY.maxAttempts);
      expect(tiered.tier3.maxAttempts).toBe(DEFAULT_TIER3_POLICY.maxAttempts);
    });

    it("maps legacy reconnect config to tier1", () => {
      const legacyCfg: OpenClawConfig = {
        web: { reconnect: { maxAttempts: 5, initialMs: 1000 } },
      };
      const tiered = resolveTieredPolicy(legacyCfg);
      expect(tiered.tier1.maxAttempts).toBe(5);
      expect(tiered.tier1.initialMs).toBe(1000);
      // tier2/3 should still have defaults
      expect(tiered.tier2.maxAttempts).toBe(DEFAULT_TIER2_POLICY.maxAttempts);
    });

    it("prefers tieredReconnect over legacy reconnect", () => {
      const mixedCfg: OpenClawConfig = {
        web: {
          reconnect: { maxAttempts: 5 },
          tieredReconnect: { tier1: { maxAttempts: 20 } },
        } as OpenClawConfig["web"],
      };
      const tiered = resolveTieredPolicy(mixedCfg);
      expect(tiered.tier1.maxAttempts).toBe(20);
    });

    it("getTierPolicy returns correct tier", () => {
      const tiered = resolveTieredPolicy(cfg);
      expect(getTierPolicy(tiered, 1)).toBe(tiered.tier1);
      expect(getTierPolicy(tiered, 2)).toBe(tiered.tier2);
      expect(getTierPolicy(tiered, 3)).toBe(tiered.tier3);
    });

    it("normalizes tier policies with valid bounds", () => {
      const tiered = resolveTieredPolicy(cfg, {
        tier1: { initialMs: 50, factor: 0.5, jitter: 5, maxAttempts: -10 },
      });
      expect(tiered.tier1.initialMs).toBeGreaterThanOrEqual(250);
      expect(tiered.tier1.factor).toBeGreaterThanOrEqual(1.1);
      expect(tiered.tier1.jitter).toBeLessThanOrEqual(1);
      expect(tiered.tier1.maxAttempts).toBeGreaterThanOrEqual(0);
    });
  });
});
