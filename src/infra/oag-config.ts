import type { OpenClawConfig } from "../config/config.js";
import type { OagConfig } from "../config/types.oag.js";
import { getTransportProfile } from "./oag-channel-profiles.js";

const DEFAULTS = {
  delivery: {
    maxRetries: 5,
    recoveryBudgetMs: 60_000,
  },
  lock: {
    timeoutMs: 2_000,
    staleMs: 30_000,
  },
  health: {
    stalePollFactor: 2,
  },
  notes: {
    dedupWindowMs: 60_000,
    maxDeliveredHistory: 20,
  },
  evolution: {
    maxStepPercent: 50,
    maxCumulativePercent: 200,
    maxNotificationsPerDay: 3,
    minCrashesForAnalysis: 2,
    cooldownMs: 4 * 60 * 60_000,
    observationWindowMs: 60 * 60_000,
    restartRegressionThreshold: 5,
    failureRegressionThreshold: 3,
    periodicAnalysisIntervalMs: 6 * 60 * 60_000,
    minChannelIncidentsForAnalysis: 5,
  },
  scheduler: {
    maxWaitMs: 5 * 60_000,
  },
  memory: {
    maxLifecycleAgeDays: 30,
  },
} as const;

function resolveOagSection(cfg?: OpenClawConfig): OagConfig | undefined {
  return cfg?.gateway?.oag;
}

/** Resolve the per-channel OAG override section. */
function resolveChannelOagSection(cfg?: OpenClawConfig, channel?: string): OagConfig | undefined {
  if (!channel) {
    return undefined;
  }
  return resolveOagSection(cfg)?.channels?.[channel];
}

// --- Delivery resolvers (transport-aware) ---

export function resolveOagDeliveryMaxRetries(cfg?: OpenClawConfig, channel?: string): number {
  // 1. User's channel-specific override
  if (channel) {
    const cv = resolveChannelOagSection(cfg, channel)?.delivery?.maxRetries;
    if (typeof cv === "number" && cv > 0) {
      return cv;
    }
  }
  // 2. Global config value
  const v = resolveOagSection(cfg)?.delivery?.maxRetries;
  if (typeof v === "number" && v > 0) {
    return v;
  }
  // 3. Transport profile default (if channel known)
  if (channel) {
    const profile = getTransportProfile(channel);
    return profile.maxRetries;
  }
  return DEFAULTS.delivery.maxRetries;
}

export function resolveOagDeliveryRecoveryBudgetMs(cfg?: OpenClawConfig, channel?: string): number {
  // 1. User's channel-specific override
  if (channel) {
    const cv = resolveChannelOagSection(cfg, channel)?.delivery?.recoveryBudgetMs;
    if (typeof cv === "number" && cv > 0) {
      return cv;
    }
  }
  // 2. Global config value
  const v = resolveOagSection(cfg)?.delivery?.recoveryBudgetMs;
  if (typeof v === "number" && v > 0) {
    return v;
  }
  // 3. Transport profile default (if channel known)
  if (channel) {
    const profile = getTransportProfile(channel);
    return profile.recoveryBudgetMs;
  }
  return DEFAULTS.delivery.recoveryBudgetMs;
}

// --- Lock resolvers (system-wide, no transport dimension) ---

export function resolveOagLockTimeoutMs(cfg?: OpenClawConfig): number {
  const v = resolveOagSection(cfg)?.lock?.timeoutMs;
  return typeof v === "number" && v > 0 ? v : DEFAULTS.lock.timeoutMs;
}

export function resolveOagLockStaleMs(cfg?: OpenClawConfig): number {
  const v = resolveOagSection(cfg)?.lock?.staleMs;
  return typeof v === "number" && v > 0 ? v : DEFAULTS.lock.staleMs;
}

// --- Health resolvers (transport-aware) ---

export function resolveOagStalePollFactor(cfg?: OpenClawConfig, channel?: string): number {
  // 1. User's channel-specific override
  if (channel) {
    const cv = resolveChannelOagSection(cfg, channel)?.health?.stalePollFactor;
    if (typeof cv === "number" && cv > 0) {
      return cv;
    }
  }
  // 2. Global config value
  const v = resolveOagSection(cfg)?.health?.stalePollFactor;
  if (typeof v === "number" && v > 0) {
    return v;
  }
  // 3. Transport profile default (if channel known)
  if (channel) {
    const profile = getTransportProfile(channel);
    return profile.stalePollFactor;
  }
  return DEFAULTS.health.stalePollFactor;
}

// --- Notes resolvers (system-wide) ---

export function resolveOagNoteDedupWindowMs(cfg?: OpenClawConfig): number {
  const v = resolveOagSection(cfg)?.notes?.dedupWindowMs;
  return typeof v === "number" && v >= 0 ? v : DEFAULTS.notes.dedupWindowMs;
}

export function resolveOagMaxDeliveredNotes(cfg?: OpenClawConfig): number {
  const v = resolveOagSection(cfg)?.notes?.maxDeliveredHistory;
  return typeof v === "number" && v > 0 ? v : DEFAULTS.notes.maxDeliveredHistory;
}

// --- Evolution resolvers (system-wide, channel param optional pass-through) ---

export function resolveOagEvolutionMaxStepPercent(cfg?: OpenClawConfig): number {
  const v = resolveOagSection(cfg)?.evolution?.maxStepPercent;
  return typeof v === "number" && v > 0 ? v : DEFAULTS.evolution.maxStepPercent;
}

export function resolveOagEvolutionMaxCumulativePercent(cfg?: OpenClawConfig): number {
  const v = resolveOagSection(cfg)?.evolution?.maxCumulativePercent;
  return typeof v === "number" && v > 0 ? v : DEFAULTS.evolution.maxCumulativePercent;
}

export function resolveOagEvolutionMaxNotificationsPerDay(cfg?: OpenClawConfig): number {
  const v = resolveOagSection(cfg)?.evolution?.maxNotificationsPerDay;
  return typeof v === "number" && v > 0 ? v : DEFAULTS.evolution.maxNotificationsPerDay;
}

export function resolveOagEvolutionMinCrashesForAnalysis(cfg?: OpenClawConfig): number {
  const v = resolveOagSection(cfg)?.evolution?.minCrashesForAnalysis;
  return typeof v === "number" && v > 0 ? v : DEFAULTS.evolution.minCrashesForAnalysis;
}

export function resolveOagEvolutionCooldownMs(cfg?: OpenClawConfig): number {
  const v = resolveOagSection(cfg)?.evolution?.cooldownMs;
  return typeof v === "number" && v > 0 ? v : DEFAULTS.evolution.cooldownMs;
}

export function resolveOagEvolutionObservationWindowMs(cfg?: OpenClawConfig): number {
  const v = resolveOagSection(cfg)?.evolution?.observationWindowMs;
  return typeof v === "number" && v > 0 ? v : DEFAULTS.evolution.observationWindowMs;
}

export function resolveOagEvolutionRestartRegressionThreshold(cfg?: OpenClawConfig): number {
  const v = resolveOagSection(cfg)?.evolution?.restartRegressionThreshold;
  return typeof v === "number" && v > 0 ? v : DEFAULTS.evolution.restartRegressionThreshold;
}

export function resolveOagEvolutionFailureRegressionThreshold(cfg?: OpenClawConfig): number {
  const v = resolveOagSection(cfg)?.evolution?.failureRegressionThreshold;
  return typeof v === "number" && v > 0 ? v : DEFAULTS.evolution.failureRegressionThreshold;
}

export function resolveOagEvolutionPeriodicAnalysisIntervalMs(cfg?: OpenClawConfig): number {
  const v = resolveOagSection(cfg)?.evolution?.periodicAnalysisIntervalMs;
  return typeof v === "number" && v > 0 ? v : DEFAULTS.evolution.periodicAnalysisIntervalMs;
}

export function resolveOagEvolutionMinChannelIncidentsForAnalysis(cfg?: OpenClawConfig): number {
  const v = resolveOagSection(cfg)?.evolution?.minChannelIncidentsForAnalysis;
  return typeof v === "number" && v > 0 ? v : DEFAULTS.evolution.minChannelIncidentsForAnalysis;
}

// --- Scheduler resolvers ---

export function resolveOagSchedulerMaxWaitMs(cfg?: OpenClawConfig): number {
  const v = resolveOagSection(cfg)?.scheduler?.maxWaitMs;
  return typeof v === "number" && v > 0 ? v : DEFAULTS.scheduler.maxWaitMs;
}

// --- Memory resolvers ---

export function resolveOagMemoryMaxLifecycleAgeDays(cfg?: OpenClawConfig): number {
  const v = resolveOagSection(cfg)?.memory?.maxLifecycleAgeDays;
  return typeof v === "number" && v > 0 ? v : DEFAULTS.memory.maxLifecycleAgeDays;
}
