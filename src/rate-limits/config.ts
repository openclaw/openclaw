/**
 * Config resolver for the rate-limits subsystem.
 *
 * Reads the `limits` key from OpenClawConfig and produces a
 * ResolvedLimitsConfig with sensible defaults filled in.
 */

import type { ResolvedLimitsConfig, RateLimitProviderConfig } from "./types.js";

/** Default limits applied when no per-provider overrides exist. */
const DEFAULT_PROVIDER_LIMITS: Required<RateLimitProviderConfig> = {
  rpm: 60,
  tpm: 100_000,
  rpd: 0, // 0 = disabled
  dailyTokenBudget: 0,
  monthlyTokenBudget: 0,
};

const DEFAULT_QUEUE = { maxSize: 100, timeoutMs: 30_000 };
const DEFAULT_BUDGETS = { warningThresholds: [0.8, 0.9, 1.0], hardBlock: false };
const DEFAULT_RETRY = { attempts: 3, minDelayMs: 500, maxDelayMs: 60_000, jitter: 0.15 };

/** Shape of the raw `limits` config key (pre-validation). */
export type RawLimitsConfig = {
  enabled?: boolean;
  defaults?: Partial<RateLimitProviderConfig>;
  providers?: Record<string, Partial<RateLimitProviderConfig> | undefined>;
  queue?: { maxSize?: number; timeoutMs?: number };
  budgets?: { warningThresholds?: number[]; hardBlock?: boolean };
  retry?: { attempts?: number; minDelayMs?: number; maxDelayMs?: number; jitter?: number };
};

export function resolveRateLimitsConfig(raw?: RawLimitsConfig): ResolvedLimitsConfig {
  const enabled = raw?.enabled ?? false; // default: false (opt-in)

  const defaults: Required<RateLimitProviderConfig> = {
    rpm: positiveOrDefault(raw?.defaults?.rpm, DEFAULT_PROVIDER_LIMITS.rpm),
    tpm: positiveOrDefault(raw?.defaults?.tpm, DEFAULT_PROVIDER_LIMITS.tpm),
    rpd: positiveOrDefault(raw?.defaults?.rpd, DEFAULT_PROVIDER_LIMITS.rpd),
    dailyTokenBudget: positiveOrDefault(
      raw?.defaults?.dailyTokenBudget,
      DEFAULT_PROVIDER_LIMITS.dailyTokenBudget,
    ),
    monthlyTokenBudget: positiveOrDefault(
      raw?.defaults?.monthlyTokenBudget,
      DEFAULT_PROVIDER_LIMITS.monthlyTokenBudget,
    ),
  };

  const providers: Record<string, RateLimitProviderConfig> = {};
  if (raw?.providers) {
    for (const [key, value] of Object.entries(raw.providers)) {
      if (!value) {
        continue;
      }
      providers[key] = {
        rpm: value.rpm,
        tpm: value.tpm,
        rpd: value.rpd,
        dailyTokenBudget: value.dailyTokenBudget,
        monthlyTokenBudget: value.monthlyTokenBudget,
      };
    }
  }

  const queue = {
    maxSize: positiveIntOrDefault(raw?.queue?.maxSize, DEFAULT_QUEUE.maxSize),
    timeoutMs: positiveIntOrDefault(raw?.queue?.timeoutMs, DEFAULT_QUEUE.timeoutMs),
  };

  const budgets = {
    warningThresholds: raw?.budgets?.warningThresholds ?? DEFAULT_BUDGETS.warningThresholds,
    hardBlock: raw?.budgets?.hardBlock ?? DEFAULT_BUDGETS.hardBlock,
  };

  const retry = {
    attempts: positiveIntOrDefault(raw?.retry?.attempts, DEFAULT_RETRY.attempts),
    minDelayMs: positiveIntOrDefault(raw?.retry?.minDelayMs, DEFAULT_RETRY.minDelayMs),
    maxDelayMs: positiveIntOrDefault(raw?.retry?.maxDelayMs, DEFAULT_RETRY.maxDelayMs),
    jitter: clamp01Limits(raw?.retry?.jitter, DEFAULT_RETRY.jitter),
  };

  return { enabled, defaults, providers, queue, budgets, retry };
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveIntOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : fallback;
}

function clamp01Limits(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, 0), 1);
}
