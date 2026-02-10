/**
 * Structured logging and metrics for the rate-limits subsystem.
 *
 * Uses the existing subsystem logger pattern. Provides optional OTel
 * counter/histogram hooks when diagnostics.otel.metrics is enabled.
 */

import { createSubsystemLogger } from "../logging.js";
import type {
    BudgetWarning,
    ProviderLimitsStatus,
    RateLimitScope,
} from "./types.js";

const log = createSubsystemLogger("rate-limits");

// --- Structured log events ---

export function logRateLimitAcquired(scope: RateLimitScope, kind: string): void {
    log.debug(`rate-limit acquired: ${scope.provider} (${kind})`, { scope, kind });
}

export function logRateLimitQueued(scope: RateLimitScope, kind: string, queueDepth: number): void {
    log.info(
        `rate-limit queued: ${scope.provider} (${kind}), depth=${queueDepth}`,
        { scope, kind, queueDepth },
    );
}

export function logRateLimitRejected(scope: RateLimitScope, kind: string, reason: string): void {
    log.warn(
        `rate-limit rejected: ${scope.provider} (${kind}) — ${reason}`,
        { scope, kind, reason },
    );
}

export function logBudgetWarning(warning: BudgetWarning): void {
    const pct = Math.round(warning.level * 100);
    log.warn(
        `budget warning: ${warning.scope.provider} ${warning.period} at ${pct}% (${warning.currentTokens.toLocaleString()}/${warning.limitTokens.toLocaleString()} tokens)`,
        {
            provider: warning.scope.provider,
            model: warning.scope.model,
            period: warning.period,
            level: warning.level,
            currentTokens: warning.currentTokens,
            limitTokens: warning.limitTokens,
        },
    );
}

export function logBudgetExceeded(scope: RateLimitScope, period: string): void {
    log.error(
        `budget exceeded: ${scope.provider} ${period} — requests blocked`,
        { scope, period },
    );
}

export function logRetryAfter429(scope: RateLimitScope, attempt: number, delayMs: number): void {
    log.info(
        `429 retry: ${scope.provider} attempt ${attempt} in ${delayMs}ms`,
        { scope, attempt, delayMs },
    );
}

// --- Metrics snapshot (for CLI and OTel export) ---

const statusStore = new Map<string, ProviderLimitsStatus>();

export function updateMetricsSnapshot(provider: string, status: ProviderLimitsStatus): void {
    statusStore.set(provider, status);
}

export function getMetricsSnapshot(): ProviderLimitsStatus[] {
    return [...statusStore.values()];
}

export function clearMetricsSnapshot(): void {
    statusStore.clear();
}
