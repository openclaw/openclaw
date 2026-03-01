import { type UsageLike } from "../agents/usage.js";

/**
 * Shared types for the rate-limits subsystem.
 */

/** Identifies who is making the request — used for per-provider and per-agent limits. */
export type RateLimitScope = {
  provider: string;
  model?: string;
};

/** Per-provider rate limit configuration. */
export type RateLimitProviderConfig = {
  rpm?: number;
  tpm?: number;
  rpd?: number;
  dailyTokenBudget?: number;
  monthlyTokenBudget?: number;
};

/** Top-level resolved limits config. */
export type ResolvedLimitsConfig = {
  enabled: boolean;
  defaults: Required<RateLimitProviderConfig>;
  providers: Record<string, RateLimitProviderConfig>;
  queue: { maxSize: number; timeoutMs: number };
  budgets: { warningThresholds: number[]; hardBlock: boolean };
  retry: { attempts: number; minDelayMs: number; maxDelayMs: number; jitter: number };
};

/** Warning emitted when a budget threshold is crossed. */
export type BudgetWarning = {
  level: number;
  scope: RateLimitScope;
  currentTokens: number;
  limitTokens: number;
  period: "daily" | "monthly";
};

/** Snapshot of a single rate-limit window. */
export type LimiterWindowState = {
  current: number;
  limit: number;
  windowMs: number;
  resetAtMs: number;
};

/** Result of a rate-limit acquire check. */
export type AcquireResult = {
  allowed: boolean;
  retryAfterMs?: number;
};

/** Budget check result. */
export type BudgetCheckResult = {
  allowed: boolean;
  warnings: BudgetWarning[];
};

/** Full status snapshot for a single provider (used by CLI and metrics). */
export type ProviderLimitsStatus = {
  provider: string;
  rpm: LimiterWindowState | null;
  tpm: LimiterWindowState | null;
  rpd: LimiterWindowState | null;
  dailyTokenBudget: { used: number; limit: number } | null;
  monthlyTokenBudget: { used: number; limit: number } | null;
  queueDepth: number;
};

/** Result type that optionally carries usage data from the provider call. */
export type CallResult<T> = T & {
  usage?: UsageLike | null;
  costUsd?: number;
};
