import type { OpenClawConfig } from "../config/config.js";
import type { OagConfig } from "../config/types.oag.js";

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

export function resolveOagDeliveryMaxRetries(cfg?: OpenClawConfig): number {
  const v = resolveOagSection(cfg)?.delivery?.maxRetries;
  return typeof v === "number" && v > 0 ? v : DEFAULTS.delivery.maxRetries;
}

export function resolveOagDeliveryRecoveryBudgetMs(cfg?: OpenClawConfig): number {
  const v = resolveOagSection(cfg)?.delivery?.recoveryBudgetMs;
  return typeof v === "number" && v > 0 ? v : DEFAULTS.delivery.recoveryBudgetMs;
}

export function resolveOagLockTimeoutMs(cfg?: OpenClawConfig): number {
  const v = resolveOagSection(cfg)?.lock?.timeoutMs;
  return typeof v === "number" && v > 0 ? v : DEFAULTS.lock.timeoutMs;
}

export function resolveOagLockStaleMs(cfg?: OpenClawConfig): number {
  const v = resolveOagSection(cfg)?.lock?.staleMs;
  return typeof v === "number" && v > 0 ? v : DEFAULTS.lock.staleMs;
}

export function resolveOagStalePollFactor(cfg?: OpenClawConfig): number {
  const v = resolveOagSection(cfg)?.health?.stalePollFactor;
  return typeof v === "number" && v > 0 ? v : DEFAULTS.health.stalePollFactor;
}

export function resolveOagNoteDedupWindowMs(cfg?: OpenClawConfig): number {
  const v = resolveOagSection(cfg)?.notes?.dedupWindowMs;
  return typeof v === "number" && v >= 0 ? v : DEFAULTS.notes.dedupWindowMs;
}

export function resolveOagMaxDeliveredNotes(cfg?: OpenClawConfig): number {
  const v = resolveOagSection(cfg)?.notes?.maxDeliveredHistory;
  return typeof v === "number" && v > 0 ? v : DEFAULTS.notes.maxDeliveredHistory;
}

// --- Evolution resolvers ---

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
