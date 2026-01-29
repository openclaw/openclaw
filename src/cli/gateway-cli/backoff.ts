// src/cli/gateway-cli/backoff.ts

const BASE_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60_000;
const JITTER_FACTOR = 0.1; // +/- 10%

/**
 * Calculate exponential backoff based on consecutive failures.
 * Formula: min(BASE * 2^(failures-1), MAX)
 *
 * @param consecutiveFailures - Number of consecutive failures (0 = no backoff)
 * @returns Backoff duration in milliseconds
 */
export function calculateBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  const exponential = BASE_BACKOFF_MS * Math.pow(2, consecutiveFailures - 1);
  return Math.min(exponential, MAX_BACKOFF_MS);
}

/**
 * Apply random jitter to a backoff value to prevent thundering herd.
 *
 * @param baseMs - Base backoff in milliseconds
 * @returns Backoff with +/- 10% jitter applied, rounded to integer
 */
export function applyJitter(baseMs: number): number {
  if (baseMs <= 0) return 0;
  const jitter = (Math.random() - 0.5) * 2 * JITTER_FACTOR * baseMs;
  return Math.round(baseMs + jitter);
}
