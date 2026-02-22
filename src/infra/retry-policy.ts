import { RateLimitError } from "@buape/carbon";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { formatErrorMessage } from "./errors.js";
import { type ProviderType } from "./provider-types.js";
import { type RetryConfig, resolveRetryConfig, retryAsync } from "./retry.js";

export type RetryRunner = <T>(fn: () => Promise<T>, label?: string) => Promise<T>;

export const DISCORD_RETRY_DEFAULTS = {
  attempts: 3,
  minDelayMs: 500,
  maxDelayMs: 30_000,
  jitter: 0.1,
};

export const TELEGRAM_RETRY_DEFAULTS = {
  attempts: 3,
  minDelayMs: 400,
  maxDelayMs: 30_000,
  jitter: 0.1,
};

const TELEGRAM_RETRY_RE = /429|timeout|connect|reset|closed|unavailable|temporarily/i;
const log = createSubsystemLogger("retry-policy");

function getTelegramRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const candidate =
    "parameters" in err && err.parameters && typeof err.parameters === "object"
      ? (err.parameters as { retry_after?: unknown }).retry_after
      : "response" in err &&
          err.response &&
          typeof err.response === "object" &&
          "parameters" in err.response
        ? (
            err.response as {
              parameters?: { retry_after?: unknown };
            }
          ).parameters?.retry_after
        : "error" in err && err.error && typeof err.error === "object" && "parameters" in err.error
          ? (err.error as { parameters?: { retry_after?: unknown } }).parameters?.retry_after
          : undefined;
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate * 1000 : undefined;
}

export function createDiscordRetryRunner(params: {
  retry?: RetryConfig;
  configRetry?: RetryConfig;
  verbose?: boolean;
}): RetryRunner {
  const retryConfig = resolveRetryConfig(DISCORD_RETRY_DEFAULTS, {
    ...params.configRetry,
    ...params.retry,
  });
  return <T>(fn: () => Promise<T>, label?: string) =>
    retryAsync(fn, {
      ...retryConfig,
      label,
      shouldRetry: (err) => err instanceof RateLimitError,
      retryAfterMs: (err) => (err instanceof RateLimitError ? err.retryAfter * 1000 : undefined),
      onRetry: params.verbose
        ? (info) => {
            const labelText = info.label ?? "request";
            const maxRetries = Math.max(1, info.maxAttempts - 1);
            log.warn(
              `discord ${labelText} rate limited, retry ${info.attempt}/${maxRetries} in ${info.delayMs}ms`,
            );
          }
        : undefined,
    });
}

export function createTelegramRetryRunner(params: {
  retry?: RetryConfig;
  configRetry?: RetryConfig;
  verbose?: boolean;
  shouldRetry?: (err: unknown) => boolean;
}): RetryRunner {
  const retryConfig = resolveRetryConfig(TELEGRAM_RETRY_DEFAULTS, {
    ...params.configRetry,
    ...params.retry,
  });
  const shouldRetry = params.shouldRetry
    ? (err: unknown) => params.shouldRetry?.(err) || TELEGRAM_RETRY_RE.test(formatErrorMessage(err))
    : (err: unknown) => TELEGRAM_RETRY_RE.test(formatErrorMessage(err));

  return <T>(fn: () => Promise<T>, label?: string) =>
    retryAsync(fn, {
      ...retryConfig,
      label,
      shouldRetry,
      retryAfterMs: getTelegramRetryAfterMs,
      onRetry: params.verbose
        ? (info) => {
            const maxRetries = Math.max(1, info.maxAttempts - 1);
            log.warn(
              `telegram send retry ${info.attempt}/${maxRetries} for ${info.label ?? label ?? "request"} in ${info.delayMs}ms: ${formatErrorMessage(info.err)}`,
            );
          }
        : undefined,
    });
}
// --- CUSTOM PROVIDER RETRY EXTENSIONS ---

export const ANTHROPIC_RETRY_DEFAULTS = {
  attempts: 4,
  minDelayMs: 1000,
  maxDelayMs: 60_000,
  jitter: 0.2,
};

const ANTHROPIC_RETRY_RE = /429|rate.limit|timeout|overloaded|service.unavailable/i;

function getAnthropicRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  // Anthropic returns retry-after in response headers or error details
  const candidate =
    "retry_after" in err ? (err as { retry_after?: unknown }).retry_after : undefined;
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return candidate * 1000;
  }
  if (typeof candidate === "string") {
    const parsed = parseFloat(candidate);
    return Number.isFinite(parsed) ? parsed * 1000 : undefined;
  }
  return undefined;
}

export function createAnthropicRetryRunner(params: {
  retry?: RetryConfig;
  configRetry?: RetryConfig;
  verbose?: boolean;
}): RetryRunner {
  const retryConfig = resolveRetryConfig(ANTHROPIC_RETRY_DEFAULTS, {
    ...params.configRetry,
    ...params.retry,
  });
  return <T>(fn: () => Promise<T>, label?: string) =>
    retryAsync(fn, {
      ...retryConfig,
      label,
      shouldRetry: (err) => ANTHROPIC_RETRY_RE.test(formatErrorMessage(err)),
      retryAfterMs: getAnthropicRetryAfterMs,
      onRetry: params.verbose
        ? (info) => {
            const labelText = info.label ?? "request";
            const maxRetries = Math.max(1, info.maxAttempts - 1);
            console.warn(
              `anthropic ${labelText} rate limited/timeout, retry ${info.attempt}/${maxRetries} in ${info.delayMs}ms`,
            );
          }
        : undefined,
    });
}

// ── OpenRouter ──────────────────────────────────────────────

export const OPENROUTER_RETRY_DEFAULTS = {
  attempts: 4,
  minDelayMs: 2000,
  maxDelayMs: 300_000, // 5 min — Cloudflare blocks can be long
  jitter: 0.15,
};

const OPENROUTER_RETRY_RE =
  /429|rate.?limit|too many requests|cloudflare|cf-ray|1020|temporarily unavailable|service.unavailable|timeout|overloaded|502|503|504/i;

const CLOUDFLARE_BLOCK_RE = /cloudflare|cf-ray|challenge-platform|1020.*access denied/i;

function getOpenRouterRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }

  // Cloudflare blocks: back off 60s minimum
  if (CLOUDFLARE_BLOCK_RE.test(formatErrorMessage(err))) {
    return 60_000;
  }

  // Standard retry-after header (OpenRouter sometimes passes through)
  const candidate =
    "retry_after" in err ? (err as { retry_after?: unknown }).retry_after : undefined;
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return candidate * 1000;
  }
  if (typeof candidate === "string") {
    const parsed = parseFloat(candidate);
    return Number.isFinite(parsed) ? parsed * 1000 : undefined;
  }
  return undefined;
}

/**
 * Retry runner tuned for OpenRouter:
 * - Longer default backoff (Cloudflare blocks last 60s+)
 * - Detects Cloudflare-specific errors vs API rate limits
 * - Higher jitter (multi-tenant environment)
 */
export function createOpenRouterRetryRunner(params: {
  retry?: RetryConfig;
  configRetry?: RetryConfig;
  verbose?: boolean;
  onCloudflareBlock?: (attempt: number) => void;
}): RetryRunner {
  const retryConfig = resolveRetryConfig(OPENROUTER_RETRY_DEFAULTS, {
    ...params.configRetry,
    ...params.retry,
  });
  return <T>(fn: () => Promise<T>, label?: string) =>
    retryAsync(fn, {
      ...retryConfig,
      label,
      shouldRetry: (err) => OPENROUTER_RETRY_RE.test(formatErrorMessage(err)),
      retryAfterMs: getOpenRouterRetryAfterMs,
      onRetry: (info) => {
        const msg = formatErrorMessage(info.err);
        const isCloudflare = CLOUDFLARE_BLOCK_RE.test(msg);

        if (isCloudflare) {
          params.onCloudflareBlock?.(info.attempt);
        }

        if (params.verbose) {
          const labelText = info.label ?? "request";
          const maxRetries = Math.max(1, info.maxAttempts - 1);
          const cause = isCloudflare ? "Cloudflare block" : "rate limited/error";
          console.warn(
            `openrouter ${labelText} ${cause}, retry ${info.attempt}/${maxRetries} in ${info.delayMs}ms`,
          );
        }
      },
    });
}

// ── Provider-Agnostic Factory ───────────────────────────────

/**
 * Create the appropriate retry runner based on detected provider.
 * Local providers get a minimal runner (1 retry, short delay).
 * Unknown providers use Anthropic defaults (conservative).
 */
export function createProviderRetryRunner(
  provider: ProviderType,
  params: {
    retry?: RetryConfig;
    configRetry?: RetryConfig;
    verbose?: boolean;
    onCloudflareBlock?: (attempt: number) => void;
  },
): RetryRunner {
  switch (provider) {
    case "anthropic":
      return createAnthropicRetryRunner(params);
    case "openrouter":
      return createOpenRouterRetryRunner(params);
    case "local":
      // Local models: minimal retry, fast failure
      return createAnthropicRetryRunner({
        ...params,
        retry: { attempts: 2, minDelayMs: 500, maxDelayMs: 5000, jitter: 0 },
      });
    default:
      // Unknown: use Anthropic defaults (conservative)
      return createAnthropicRetryRunner(params);
  }
}
