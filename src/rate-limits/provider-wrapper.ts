/**
 * Rate-limited provider wrapper — the main middleware.
 *
 * Composes limiter, budget, and queue to wrap any provider call with:
 *   1. Rate-limit check (RPM/TPM) → queue if exceeded
 *   2. Budget check → warn/block if exceeded
 *   3. Execute the call
 *   4. Record usage (tokens + cost)
 *   5. On 429 → retry with exponential backoff (reusing infra/retry.ts)
 *   6. Emit structured log events
 */

import type {
  ProviderLimitsStatus,
  RateLimitProviderConfig,
  RateLimitScope,
  ResolvedLimitsConfig,
  CallResult,
} from "./types.js";
import { normalizeUsage, type UsageLike } from "../agents/usage.js";
import { retryAsync, type RetryConfig } from "../infra/retry.js";
import { BudgetTracker } from "./budget.js";
import { SlidingWindowLimiter } from "./limiter.js";
import {
  logBudgetExceeded,
  logBudgetWarning,
  logRateLimitAcquired,
  logRateLimitQueued,
  logRateLimitRejected,
  logRetryAfter429,
  updateMetricsSnapshot,
} from "./metrics.js";
import { RateLimitQueue } from "./queue.js";

const ONE_MINUTE_MS = 60_000;
const ONE_DAY_MS = 86_400_000;

export class RateLimitedRunner {
  readonly limiter: SlidingWindowLimiter;
  readonly budget: BudgetTracker;
  readonly queue: RateLimitQueue;
  private readonly config: ResolvedLimitsConfig;

  constructor(params: { config: ResolvedLimitsConfig; stateDir?: string }) {
    this.config = params.config;
    this.limiter = new SlidingWindowLimiter();
    this.budget = new BudgetTracker({
      stateDir: params.stateDir,
      warningThresholds: params.config.budgets.warningThresholds,
      hardBlock: params.config.budgets.hardBlock,
      providerLimits: params.config.providers,
      defaultLimits: params.config.defaults,
    });
    this.queue = new RateLimitQueue({
      maxSize: params.config.queue.maxSize,
      timeoutMs: params.config.queue.timeoutMs,
    });
  }

  /** Generate the limiter key for a scope (provider + model). */
  private getLimiterKey(scope: RateLimitScope): string {
    return `${scope.provider}:${scope.model || "default"}`;
  }

  /** Ensure the limiter is configured for a given provider. */
  private ensureLimiterConfigured(scope: RateLimitScope): void {
    const providerConfig: RateLimitProviderConfig = {
      ...this.config.defaults,
      ...this.config.providers[scope.provider],
    };
    const baseKey = this.getLimiterKey(scope);

    const rpmKey = `${baseKey}:rpm`;
    if (providerConfig.rpm && providerConfig.rpm > 0 && !this.limiter.getState(rpmKey)) {
      this.limiter.configure(rpmKey, providerConfig.rpm, ONE_MINUTE_MS);
    }

    const tpmKey = `${baseKey}:tpm`;
    if (providerConfig.tpm && providerConfig.tpm > 0 && !this.limiter.getState(tpmKey)) {
      this.limiter.configure(tpmKey, providerConfig.tpm, ONE_MINUTE_MS);
    }

    const rpdKey = `${baseKey}:rpd`;
    if (providerConfig.rpd && providerConfig.rpd > 0 && !this.limiter.getState(rpdKey)) {
      this.limiter.configure(rpdKey, providerConfig.rpd, ONE_DAY_MS);
    }
  }

  /**
   * Wrap an API call with rate limiting, budgeting, and 429 retry.
   *
   * @param scope - Who is making the call (provider, model).
   * @param fn    - The actual provider call. Should return usage data if available.
   */
  async withRateLimit<T>(
    scope: RateLimitScope,
    fn: () => Promise<CallResult<T>>,
  ): Promise<CallResult<T>> {
    if (!this.config.enabled) {
      return fn();
    }

    this.ensureLimiterConfigured(scope);
    const key = this.getLimiterKey(scope);

    // 1. RPM check.
    const rpmResult = this.limiter.acquire(`${key}:rpm`);
    if (!rpmResult.allowed) {
      logRateLimitQueued(scope, "rpm", this.queue.getQueueDepth(`${key}:rpm`));
      return this.queue.enqueue(
        `${key}:rpm`,
        rpmResult.retryAfterMs ?? ONE_MINUTE_MS,
        () => this.limiter.acquire(`${key}:rpm`),
        () =>
          this.executeWithRetry(scope, fn).catch((err) => {
            this.limiter.release(`${key}:rpm`);
            throw err;
          }),
      );
    }

    logRateLimitAcquired(scope, "rpm");

    // 4. Execute with 429 retry.
    try {
      return await this.executeWithRetry(scope, fn);
    } catch (err) {
      this.limiter.release(`${key}:rpm`);
      throw err;
    }
  }

  private async executeWithRetry<T>(
    scope: RateLimitScope,
    fn: () => Promise<CallResult<T>>,
  ): Promise<CallResult<T>> {
    const key = this.getLimiterKey(scope);

    // 2. RPD check.
    const rpdResult = this.limiter.acquire(`${key}:rpd`);
    if (!rpdResult.allowed) {
      logRateLimitRejected(scope, "rpd", "daily request limit exceeded");
      throw new RateLimitExceededError(
        `Daily request limit exceeded for ${scope.provider}`,
        rpdResult.retryAfterMs,
      );
    }

    // 3. Budget check.
    try {
      const budgetResult = this.budget.checkBudget(scope);
      for (const warning of budgetResult.warnings) {
        logBudgetWarning(warning);
      }
      if (!budgetResult.allowed) {
        logBudgetExceeded(scope, "daily/monthly");
        throw new BudgetExceededError(`Budget exceeded for ${scope.provider} — requests blocked`);
      }

      const retryConfig: RetryConfig = this.config.retry;
      let accumulatedTokens = 0;

      const result = await retryAsync<CallResult<T>>(fn, {
        ...retryConfig,
        label: `${scope.provider}/${scope.model ?? "default"}`,
        shouldRetry: (err) => is429Error(err),
        retryAfterMs: (err) => extractRetryAfterMsFromProvider(err),
        onRetry: (info) => {
          logRetryAfter429(scope, info.attempt, info.delayMs);
          // Accumulate usage from failed attempt if available
          const usage = normalizeUsage((info.err as { usage?: unknown })?.usage as UsageLike);
          if (usage) {
            accumulatedTokens += usage.total ?? (usage.input ?? 0) + (usage.output ?? 0);
          }
        },
      });

      // 5. Record usage after successful call.
      const usage = normalizeUsage(result.usage);
      if (usage) {
        accumulatedTokens += usage.total ?? (usage.input ?? 0) + (usage.output ?? 0);
      }

      if (accumulatedTokens > 0) {
        this.recordUsage(scope, accumulatedTokens);
      }

      // 6. Update metrics snapshot.
      this.refreshMetrics(scope);

      return result;
    } catch (err) {
      this.limiter.release(`${key}:rpd`);
      throw err;
    }
  }

  private recordUsage(scope: RateLimitScope, tokens: number): void {
    const key = this.getLimiterKey(scope);
    if (tokens > 0) {
      this.limiter.recordTokens(`${key}:tpm`, tokens);
      // Track budget via tokens (ignoring costUsd as it's often undefined)
      this.budget.record_usage(scope, tokens);
    }
  }

  private refreshMetrics(scope: RateLimitScope): void {
    const key = this.getLimiterKey(scope);
    const budgetStatus = this.budget.getStatus(scope);
    const status: ProviderLimitsStatus = {
      provider: scope.provider,
      rpm: this.limiter.getState(`${key}:rpm`),
      tpm: this.limiter.getState(`${key}:tpm`),
      rpd: this.limiter.getState(`${key}:rpd`),
      dailyTokenBudget: budgetStatus.dailyLimitTokens
        ? { used: budgetStatus.dailyUsedTokens, limit: budgetStatus.dailyLimitTokens }
        : null,
      monthlyTokenBudget: budgetStatus.monthlyLimitTokens
        ? { used: budgetStatus.monthlyUsedTokens, limit: budgetStatus.monthlyLimitTokens }
        : null,
      queueDepth: this.queue.getQueueDepth(`${key}:rpm`),
    };
    // Store under the unique key (provider:model) so CLI shows all models.
    updateMetricsSnapshot(key, status);
  }

  /** Get status for all tracked providers. */
  getAllStatus(): ProviderLimitsStatus[] {
    const scopes = new Map<string, RateLimitScope>();

    // Discover active limiters (provider:model:type)
    for (const key of this.limiter.keys()) {
      const lastColon = key.lastIndexOf(":");
      if (lastColon === -1) {
        continue;
      }
      const base = key.substring(0, lastColon); // "provider:model"

      const firstColon = base.indexOf(":");
      if (firstColon !== -1) {
        const provider = base.substring(0, firstColon);
        const model = base.substring(firstColon + 1);
        scopes.set(base, { provider, model });
      } else {
        // Should not happen with new key format, but fallback:
        scopes.set(base, { provider: base });
      }
    }

    // Discover active budgets (provider/model)
    for (const budgetKey of this.budget.trackedProviders()) {
      const parts = budgetKey.split("/");
      if (parts.length === 2) {
        const [provider, model] = parts;
        const limitKey = `${provider}:${model}`; // Normalize to limiter format
        if (!scopes.has(limitKey)) {
          scopes.set(limitKey, { provider, model });
        }
      } else {
        const provider = parts[0];
        const limitKey = `${provider}:default`;
        if (!scopes.has(limitKey)) {
          scopes.set(limitKey, { provider, model: "default" });
        }
      }
    }

    const result: ProviderLimitsStatus[] = [];
    for (const scope of scopes.values()) {
      this.refreshMetrics(scope);
      // metrics snapshot is updated by refreshMetrics
    }

    // We can't easily return the internal snapshot here without importing it or
    // changing the return type significantly. But refreshMetrics updates the
    // global snapshot in metrics.ts, which is what CLI usage looks at via
    // the runner if it calls getAllStatus (which it does).
    // Wait, CLI calls runner.getAllStatus() and prints the result.
    // So we must return the constructed status list.

    for (const scope of scopes.values()) {
      const key = this.getLimiterKey(scope);
      const budgetStatus = this.budget.getStatus(scope);
      result.push({
        provider: key, // Use "provider:model" as the display ID
        rpm: this.limiter.getState(`${key}:rpm`),
        tpm: this.limiter.getState(`${key}:tpm`),
        rpd: this.limiter.getState(`${key}:rpd`),
        dailyTokenBudget: budgetStatus.dailyLimitTokens
          ? { used: budgetStatus.dailyUsedTokens, limit: budgetStatus.dailyLimitTokens }
          : null,
        monthlyTokenBudget: budgetStatus.monthlyLimitTokens
          ? { used: budgetStatus.monthlyUsedTokens, limit: budgetStatus.monthlyLimitTokens }
          : null,
        queueDepth: this.queue.getQueueDepth(`${key}:rpm`),
      });
    }

    return result;
  }

  /** Reset all limiters and budgets. */
  reset(provider?: string): void {
    if (provider) {
      // Reset all keys starting with provider:
      for (const key of this.limiter.keys()) {
        if (key.startsWith(`${provider}:`)) {
          this.limiter.reset(key);
        }
      }
      this.budget.reset({ provider });
    } else {
      this.limiter.reset();
      this.budget.reset();
    }
  }

  /** Flush budget state for graceful shutdown. */
  flush(): void {
    this.budget.flush();
  }
}

// --- Error types ---

export class RateLimitExceededError extends Error {
  readonly code = "RATE_LIMIT_EXCEEDED";
  readonly retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "RateLimitExceededError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class BudgetExceededError extends Error {
  readonly code = "BUDGET_EXCEEDED";
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

// --- Helpers ---

function is429Error(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  if ("status" in err && err.status === 429) {
    return true;
  }
  if ("statusCode" in err && err.statusCode === 429) {
    return true;
  }
  if ("code" in err && err.code === 429) {
    return true;
  }
  const message = "message" in err && typeof err.message === "string" ? err.message : "";
  return /429|rate.?limit/i.test(message);
}

function extractRetryAfterMsFromProvider(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  // Standard Retry-After header (seconds).
  if ("headers" in err && err.headers && typeof err.headers === "object") {
    const headers = err.headers as Record<string, unknown>;
    const retryAfter = headers["retry-after"] ?? headers["Retry-After"];
    if (typeof retryAfter === "string") {
      const seconds = Number.parseFloat(retryAfter);
      if (Number.isFinite(seconds) && seconds > 0) {
        return seconds * 1000;
      }
    }
    if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
      return retryAfter * 1000;
    }
  }
  // Some providers embed retry_after at top level.
  if ("retry_after" in err) {
    const val = (err as { retry_after?: unknown }).retry_after;
    if (typeof val === "number" && Number.isFinite(val) && val > 0) {
      return val * 1000;
    }
  }
  return undefined;
}

// --- Singleton ---

let _instance: RateLimitedRunner | null = null;

/** Get or create the global rate-limited runner instance. */
export function getRateLimitedRunner(params?: {
  config: ResolvedLimitsConfig;
  stateDir?: string;
}): RateLimitedRunner {
  if (_instance) {
    return _instance;
  }
  if (!params) {
    throw new Error("RateLimitedRunner not initialized — call with config first");
  }
  _instance = new RateLimitedRunner(params);
  return _instance;
}

/** Reset the singleton (for testing). */
export function resetRateLimitedRunner(): void {
  if (_instance) {
    _instance.flush();
  }
  _instance = null;
}
