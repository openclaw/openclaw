/**
 * Minimal global tracker for last user activity timestamp.
 * Updated on each inbound user message; consumed by the dreaming process
 * to decide whether to skip a dream cycle (user is still active).
 */

let lastUserActivityMs: number | undefined;

/** Record that a user message was just received. */
export function touchUserActivity(): void {
  lastUserActivityMs = Date.now();
}

/** Get the last recorded user-activity timestamp (epoch ms), or undefined. */
export function getLastUserActivityMs(): number | undefined {
  return lastUserActivityMs;
}
