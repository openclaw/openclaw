import { describe, expect, it } from "vitest";
import {
  resolveOagDeliveryMaxRetries,
  resolveOagDeliveryRecoveryBudgetMs,
  resolveOagLockTimeoutMs,
  resolveOagLockStaleMs,
  resolveOagStalePollFactor,
  resolveOagNoteDedupWindowMs,
  resolveOagMaxDeliveredNotes,
  resolveOagEvolutionMaxStepPercent,
  resolveOagEvolutionMaxCumulativePercent,
  resolveOagEvolutionMaxNotificationsPerDay,
  resolveOagEvolutionMinCrashesForAnalysis,
  resolveOagEvolutionCooldownMs,
  resolveOagEvolutionObservationWindowMs,
  resolveOagEvolutionRestartRegressionThreshold,
  resolveOagEvolutionFailureRegressionThreshold,
  resolveOagEvolutionPeriodicAnalysisIntervalMs,
  resolveOagSchedulerMaxWaitMs,
  resolveOagMemoryMaxLifecycleAgeDays,
} from "./oag-config.js";

describe("oag-config resolvers", () => {
  it("returns defaults when config is undefined", () => {
    expect(resolveOagDeliveryMaxRetries()).toBe(5);
    expect(resolveOagDeliveryRecoveryBudgetMs()).toBe(60_000);
    expect(resolveOagLockTimeoutMs()).toBe(2_000);
    expect(resolveOagLockStaleMs()).toBe(30_000);
    expect(resolveOagStalePollFactor()).toBe(2);
    expect(resolveOagNoteDedupWindowMs()).toBe(60_000);
    expect(resolveOagMaxDeliveredNotes()).toBe(20);
  });

  it("returns defaults when gateway.oag is absent", () => {
    expect(resolveOagDeliveryMaxRetries({ gateway: {} })).toBe(5);
    expect(resolveOagLockTimeoutMs({ gateway: { oag: {} } })).toBe(2_000);
  });

  it("returns overridden values when set", () => {
    const cfg = { gateway: { oag: { delivery: { maxRetries: 10 }, lock: { staleMs: 60_000 } } } };
    expect(resolveOagDeliveryMaxRetries(cfg)).toBe(10);
    expect(resolveOagLockStaleMs(cfg)).toBe(60_000);
    // Non-overridden values still return defaults
    expect(resolveOagLockTimeoutMs(cfg)).toBe(2_000);
  });

  it("ignores invalid values and returns defaults", () => {
    const cfg = { gateway: { oag: { delivery: { maxRetries: -1 }, lock: { staleMs: 0 } } } };
    expect(resolveOagDeliveryMaxRetries(cfg)).toBe(5);
    expect(resolveOagLockStaleMs(cfg)).toBe(30_000);
  });

  it("allows dedupWindowMs to be zero (disables dedup)", () => {
    const cfg = { gateway: { oag: { notes: { dedupWindowMs: 0 } } } };
    expect(resolveOagNoteDedupWindowMs(cfg)).toBe(0);
  });
});

describe("oag-config evolution resolvers", () => {
  it("returns defaults when config is undefined", () => {
    expect(resolveOagEvolutionMaxStepPercent()).toBe(50);
    expect(resolveOagEvolutionMaxCumulativePercent()).toBe(200);
    expect(resolveOagEvolutionMaxNotificationsPerDay()).toBe(3);
    expect(resolveOagEvolutionMinCrashesForAnalysis()).toBe(2);
    expect(resolveOagEvolutionCooldownMs()).toBe(4 * 60 * 60_000);
    expect(resolveOagEvolutionObservationWindowMs()).toBe(60 * 60_000);
    expect(resolveOagEvolutionRestartRegressionThreshold()).toBe(5);
    expect(resolveOagEvolutionFailureRegressionThreshold()).toBe(3);
    expect(resolveOagEvolutionPeriodicAnalysisIntervalMs()).toBe(6 * 60 * 60_000);
  });

  it("returns overridden evolution values when set", () => {
    const cfg = {
      gateway: {
        oag: {
          evolution: {
            maxStepPercent: 25,
            cooldownMs: 7200000,
            restartRegressionThreshold: 10,
          },
        },
      },
    };
    expect(resolveOagEvolutionMaxStepPercent(cfg)).toBe(25);
    expect(resolveOagEvolutionCooldownMs(cfg)).toBe(7200000);
    expect(resolveOagEvolutionRestartRegressionThreshold(cfg)).toBe(10);
    // Non-overridden still return defaults
    expect(resolveOagEvolutionMaxCumulativePercent(cfg)).toBe(200);
  });

  it("ignores invalid evolution values and returns defaults", () => {
    const cfg = {
      gateway: {
        oag: {
          evolution: {
            maxStepPercent: -10,
            cooldownMs: 0,
          },
        },
      },
    };
    expect(resolveOagEvolutionMaxStepPercent(cfg)).toBe(50);
    expect(resolveOagEvolutionCooldownMs(cfg)).toBe(4 * 60 * 60_000);
  });

  it("returns overridden periodicAnalysisIntervalMs when set", () => {
    const cfg = {
      gateway: { oag: { evolution: { periodicAnalysisIntervalMs: 3_600_000 } } },
    };
    expect(resolveOagEvolutionPeriodicAnalysisIntervalMs(cfg)).toBe(3_600_000);
  });

  it("ignores invalid periodicAnalysisIntervalMs and returns default", () => {
    const cfg = {
      gateway: { oag: { evolution: { periodicAnalysisIntervalMs: -1 } } },
    };
    expect(resolveOagEvolutionPeriodicAnalysisIntervalMs(cfg)).toBe(6 * 60 * 60_000);
  });
});

describe("oag-config scheduler resolvers", () => {
  it("returns default maxWaitMs when config is undefined", () => {
    expect(resolveOagSchedulerMaxWaitMs()).toBe(5 * 60_000);
  });

  it("returns overridden maxWaitMs when set", () => {
    const cfg = { gateway: { oag: { scheduler: { maxWaitMs: 120_000 } } } };
    expect(resolveOagSchedulerMaxWaitMs(cfg)).toBe(120_000);
  });

  it("ignores invalid maxWaitMs and returns default", () => {
    const cfg = { gateway: { oag: { scheduler: { maxWaitMs: -1 } } } };
    expect(resolveOagSchedulerMaxWaitMs(cfg)).toBe(5 * 60_000);
  });
});

describe("oag-config memory resolvers", () => {
  it("returns default maxLifecycleAgeDays when config is undefined", () => {
    expect(resolveOagMemoryMaxLifecycleAgeDays()).toBe(30);
  });

  it("returns overridden maxLifecycleAgeDays when set", () => {
    const cfg = { gateway: { oag: { memory: { maxLifecycleAgeDays: 60 } } } };
    expect(resolveOagMemoryMaxLifecycleAgeDays(cfg)).toBe(60);
  });

  it("ignores invalid maxLifecycleAgeDays and returns default", () => {
    const cfg = { gateway: { oag: { memory: { maxLifecycleAgeDays: 0 } } } };
    expect(resolveOagMemoryMaxLifecycleAgeDays(cfg)).toBe(30);
  });
});
