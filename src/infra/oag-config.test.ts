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
  resolveOagEvolutionMinChannelIncidentsForAnalysis,
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

describe("oag-config channel-specific cascade", () => {
  it("channel-specific override takes precedence over global config", () => {
    const cfg = {
      gateway: {
        oag: {
          delivery: { maxRetries: 10 },
          channels: {
            telegram: { delivery: { maxRetries: 20 } },
          },
        },
      },
    };
    expect(resolveOagDeliveryMaxRetries(cfg, "telegram")).toBe(20);
    // Global config still applies for channels without override
    expect(resolveOagDeliveryMaxRetries(cfg, "discord")).toBe(10);
  });

  it("falls through to global config when channel override is absent", () => {
    const cfg = {
      gateway: {
        oag: {
          delivery: { recoveryBudgetMs: 45_000 },
          channels: {},
        },
      },
    };
    expect(resolveOagDeliveryRecoveryBudgetMs(cfg, "telegram")).toBe(45_000);
  });

  it("uses transport profile default when no config at all for that channel", () => {
    // telegram is a polling channel with profile maxRetries=8
    expect(resolveOagDeliveryMaxRetries(undefined, "telegram")).toBe(8);
    // discord is websocket with profile maxRetries=5
    expect(resolveOagDeliveryMaxRetries(undefined, "discord")).toBe(5);
    // signal is local with profile maxRetries=3
    expect(resolveOagDeliveryMaxRetries(undefined, "signal")).toBe(3);
  });

  it("uses transport profile recoveryBudgetMs when no config", () => {
    // polling: 90_000
    expect(resolveOagDeliveryRecoveryBudgetMs(undefined, "telegram")).toBe(90_000);
    // websocket: 30_000
    expect(resolveOagDeliveryRecoveryBudgetMs(undefined, "slack")).toBe(30_000);
    // local: 15_000
    expect(resolveOagDeliveryRecoveryBudgetMs(undefined, "imessage")).toBe(15_000);
    // webhook: 60_000
    expect(resolveOagDeliveryRecoveryBudgetMs(undefined, "line")).toBe(60_000);
  });

  it("uses transport profile stalePollFactor when no config", () => {
    // polling: 2
    expect(resolveOagStalePollFactor(undefined, "telegram")).toBe(2);
    // websocket: 1
    expect(resolveOagStalePollFactor(undefined, "discord")).toBe(1);
  });

  it("channel-specific stalePollFactor overrides global and transport", () => {
    const cfg = {
      gateway: {
        oag: {
          health: { stalePollFactor: 3 },
          channels: {
            telegram: { health: { stalePollFactor: 5 } },
          },
        },
      },
    };
    expect(resolveOagStalePollFactor(cfg, "telegram")).toBe(5);
    expect(resolveOagStalePollFactor(cfg, "matrix")).toBe(3);
    expect(resolveOagStalePollFactor(cfg)).toBe(3);
  });

  it("3-tier cascade: channel config > global config > transport profile > hardcoded default", () => {
    // Tier 3: no config, known channel -> transport profile default
    expect(resolveOagDeliveryMaxRetries(undefined, "telegram")).toBe(8);
    // Tier 2: global config set -> uses global
    const globalOnly = { gateway: { oag: { delivery: { maxRetries: 12 } } } };
    expect(resolveOagDeliveryMaxRetries(globalOnly, "telegram")).toBe(12);
    // Tier 1: channel config set -> uses channel override
    const withChannel = {
      gateway: {
        oag: {
          delivery: { maxRetries: 12 },
          channels: { telegram: { delivery: { maxRetries: 25 } } },
        },
      },
    };
    expect(resolveOagDeliveryMaxRetries(withChannel, "telegram")).toBe(25);
  });

  it("falls through to hardcoded default when no channel specified and no config", () => {
    expect(resolveOagDeliveryMaxRetries()).toBe(5);
    expect(resolveOagDeliveryRecoveryBudgetMs()).toBe(60_000);
    expect(resolveOagStalePollFactor()).toBe(2);
  });

  it("ignores invalid channel-specific values and falls through", () => {
    const cfg = {
      gateway: {
        oag: {
          delivery: { maxRetries: 10 },
          channels: {
            telegram: { delivery: { maxRetries: -1 } },
          },
        },
      },
    };
    // Invalid channel override -> falls to global
    expect(resolveOagDeliveryMaxRetries(cfg, "telegram")).toBe(10);
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
    expect(resolveOagEvolutionMinChannelIncidentsForAnalysis()).toBe(5);
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

describe("oag-config minChannelIncidentsForAnalysis resolver", () => {
  it("returns default (5) when config is undefined", () => {
    expect(resolveOagEvolutionMinChannelIncidentsForAnalysis()).toBe(5);
  });

  it("returns overridden value when set", () => {
    const cfg = {
      gateway: { oag: { evolution: { minChannelIncidentsForAnalysis: 10 } } },
    };
    expect(resolveOagEvolutionMinChannelIncidentsForAnalysis(cfg)).toBe(10);
  });

  it("ignores invalid value (zero) and returns default", () => {
    const cfg = {
      gateway: { oag: { evolution: { minChannelIncidentsForAnalysis: 0 } } },
    };
    expect(resolveOagEvolutionMinChannelIncidentsForAnalysis(cfg)).toBe(5);
  });

  it("ignores invalid value (negative) and returns default", () => {
    const cfg = {
      gateway: { oag: { evolution: { minChannelIncidentsForAnalysis: -3 } } },
    };
    expect(resolveOagEvolutionMinChannelIncidentsForAnalysis(cfg)).toBe(5);
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
