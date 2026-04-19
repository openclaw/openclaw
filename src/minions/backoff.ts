import type { BackoffType } from "./types.js";

export function calculateBackoff(opts: {
  backoffType: BackoffType;
  backoffDelay: number;
  backoffJitter: number;
  attemptsMade: number;
}): number {
  let delay: number;
  if (opts.backoffType === "exponential") {
    delay = Math.pow(2, Math.max(opts.attemptsMade - 1, 0)) * opts.backoffDelay;
  } else {
    delay = opts.backoffDelay;
  }

  if (opts.backoffJitter > 0) {
    const jitterRange = delay * opts.backoffJitter;
    delay += Math.random() * jitterRange * 2 - jitterRange;
  }

  return Math.max(delay, 0);
}
