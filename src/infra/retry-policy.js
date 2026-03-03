import { RateLimitError } from "@buape/carbon";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { formatErrorMessage } from "./errors.js";
import { resolveRetryConfig, retryAsync } from "./retry.js";
export const DISCORD_RETRY_DEFAULTS = {
    attempts: 3,
    minDelayMs: 500,
    maxDelayMs: 30000,
    jitter: 0.1,
};
export const TELEGRAM_RETRY_DEFAULTS = {
    attempts: 3,
    minDelayMs: 400,
    maxDelayMs: 30000,
    jitter: 0.1,
};
const TELEGRAM_RETRY_RE = /429|timeout|connect|reset|closed|unavailable|temporarily/i;
const log = createSubsystemLogger("retry-policy");
function getTelegramRetryAfterMs(err) {
    if (!err || typeof err !== "object") {
        return undefined;
    }
    const candidate = "parameters" in err && err.parameters && typeof err.parameters === "object"
        ? err.parameters.retry_after
        : "response" in err &&
            err.response &&
            typeof err.response === "object" &&
            "parameters" in err.response
            ? err.response.parameters?.retry_after
            : "error" in err && err.error && typeof err.error === "object" && "parameters" in err.error
                ? err.error.parameters?.retry_after
                : undefined;
    return typeof candidate === "number" && Number.isFinite(candidate) ? candidate * 1000 : undefined;
}
export function createDiscordRetryRunner(params) {
    const retryConfig = resolveRetryConfig(DISCORD_RETRY_DEFAULTS, {
        ...params.configRetry,
        ...params.retry,
    });
    return (fn, label) => retryAsync(fn, {
        ...retryConfig,
        label,
        shouldRetry: (err) => err instanceof RateLimitError,
        retryAfterMs: (err) => (err instanceof RateLimitError ? err.retryAfter * 1000 : undefined),
        onRetry: params.verbose
            ? (info) => {
                const labelText = info.label ?? "request";
                const maxRetries = Math.max(1, info.maxAttempts - 1);
                log.warn(`discord ${labelText} rate limited, retry ${info.attempt}/${maxRetries} in ${info.delayMs}ms`);
            }
            : undefined,
    });
}
export function createTelegramRetryRunner(params) {
    const retryConfig = resolveRetryConfig(TELEGRAM_RETRY_DEFAULTS, {
        ...params.configRetry,
        ...params.retry,
    });
    const shouldRetry = params.shouldRetry
        ? (err) => params.shouldRetry?.(err) || TELEGRAM_RETRY_RE.test(formatErrorMessage(err))
        : (err) => TELEGRAM_RETRY_RE.test(formatErrorMessage(err));
    return (fn, label) => retryAsync(fn, {
        ...retryConfig,
        label,
        shouldRetry,
        retryAfterMs: getTelegramRetryAfterMs,
        onRetry: params.verbose
            ? (info) => {
                const maxRetries = Math.max(1, info.maxAttempts - 1);
                log.warn(`telegram send retry ${info.attempt}/${maxRetries} for ${info.label ?? label ?? "request"} in ${info.delayMs}ms: ${formatErrorMessage(info.err)}`);
            }
            : undefined,
    });
}
