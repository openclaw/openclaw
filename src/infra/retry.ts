import { asFiniteNumber } from "../shared/number-coercion.js";
import { sleep } from "../utils.js";
import { generateSecureFraction } from "./secure-random.js";

export type RetryConfig = {
  attempts?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  jitter?: number;
};

export type RetryInfo = {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  err: unknown;
  label?: string;
};

export type RetryOptions = RetryConfig & {
  label?: string;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  retryAfterMs?: (err: unknown) => number | undefined;
  onRetry?: (info: RetryInfo) => void;
};

const DEFAULT_RETRY_CONFIG = {
  attempts: 3,
  minDelayMs: 300,
  maxDelayMs: 30_000,
  jitter: 0,
};

const clampNumber = (value: unknown, fallback: number, min?: number, max?: number) => {
  const next = asFiniteNumber(value);
  if (next === undefined) {
    return fallback;
  }
  const floor = typeof min === "number" ? min : Number.NEGATIVE_INFINITY;
  const ceiling = typeof max === "number" ? max : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(next, floor), ceiling);
};

export function resolveRetryConfig(
  defaults: Required<RetryConfig> = DEFAULT_RETRY_CONFIG,
  overrides?: RetryConfig,
): Required<RetryConfig> {
  const attempts = Math.max(1, Math.round(clampNumber(overrides?.attempts, defaults.attempts, 1)));
  const minDelayMs = Math.max(
    0,
    Math.round(clampNumber(overrides?.minDelayMs, defaults.minDelayMs, 0)),
  );
  const maxDelayMs = Math.max(
    minDelayMs,
    Math.round(clampNumber(overrides?.maxDelayMs, defaults.maxDelayMs, 0)),
  );
  const jitter = clampNumber(overrides?.jitter, defaults.jitter, 0, 1);
  return { attempts, minDelayMs, maxDelayMs, jitter };
}

type JitterMode = "symmetric" | "positive";

function applyJitter(delayMs: number, jitter: number, mode: JitterMode = "symmetric"): number {
  if (jitter <= 0) {
    return delayMs;
  }
  // `symmetric` spreads within ±jitter around the base delay; correct for pure
  // exponential backoff where going slightly early is harmless. `positive`
  // only adds to the base delay; use it when the base delay is already a
  // lower bound the caller must respect (for example a server-supplied
  // Retry-After) so concurrent clients still spread without ever dipping
  // below the caller's floor.
  const fraction = generateSecureFraction();
  const offset = mode === "positive" ? fraction * jitter : (fraction * 2 - 1) * jitter;
  return Math.max(0, Math.round(delayMs * (1 + offset)));
}

export async function retryAsync<T>(
  fn: () => Promise<T>,
  attemptsOrOptions: number | RetryOptions = 3,
  initialDelayMs = 300,
): Promise<T> {
  if (typeof attemptsOrOptions === "number") {
    const attempts = Math.max(1, Math.round(attemptsOrOptions));
    let lastErr: unknown;
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (i === attempts - 1) {
          break;
        }
        const delay = initialDelayMs * 2 ** i;
        await sleep(delay);
      }
    }
    throw lastErr ?? new Error("Retry failed");
  }

  const options = attemptsOrOptions;

  const resolved = resolveRetryConfig(DEFAULT_RETRY_CONFIG, options);
  const maxAttempts = resolved.attempts;
  const minDelayMs = resolved.minDelayMs;
  const maxDelayMs =
    Number.isFinite(resolved.maxDelayMs) && resolved.maxDelayMs > 0
      ? resolved.maxDelayMs
      : Number.POSITIVE_INFINITY;
  const jitter = resolved.jitter;
  const shouldRetry = options.shouldRetry ?? (() => true);
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !shouldRetry(err, attempt)) {
        break;
      }

      const retryAfterMs = options.retryAfterMs?.(err);
      const hasRetryAfter = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs);
      const baseDelay = hasRetryAfter
        ? Math.max(retryAfterMs, minDelayMs)
        : minDelayMs * 2 ** (attempt - 1);
      let delay = Math.min(baseDelay, maxDelayMs);
      // Server-supplied Retry-After is a lower-bound contract with the
      // upstream rate limiter; symmetric jitter would let roughly half the
      // retries land before the requested time and invite escalation. Use
      // positive-only jitter in that case so clients still spread but never
      // dip below the server's hint.
      //
      // Exception: when retryAfterMs > maxDelayMs the base is already capped
      // to maxDelayMs, so positive jitter would be erased by the final clamp
      // below and every retry would land at exactly maxDelayMs — reintroducing
      // the thundering herd we are trying to avoid. In that case the server
      // contract is already unsatisfiable, so fall back to symmetric jitter
      // to preserve spread.
      // Use strict `<` so the `retryAfterMs === maxDelayMs` boundary also
      // falls back to symmetric jitter. Positive jitter on the boundary only
      // produces values ≥ maxDelayMs, which the final clamp below collapses
      // back to exactly maxDelayMs for every retry — the same thundering-herd
      // shape the fallback is meant to avoid.
      const canHonorRetryAfter =
        hasRetryAfter && typeof retryAfterMs === "number" && retryAfterMs < maxDelayMs;
      delay = applyJitter(delay, jitter, canHonorRetryAfter ? "positive" : "symmetric");
      delay = Math.min(Math.max(delay, minDelayMs), maxDelayMs);

      options.onRetry?.({
        attempt,
        maxAttempts,
        delayMs: delay,
        err,
        label: options.label,
      });
      if (delay > 0) {
        await sleep(delay);
      }
    }
  }

  throw lastErr ?? new Error("Retry failed");
}
