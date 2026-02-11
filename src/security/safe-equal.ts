import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison for secret tokens.
 *
 * Note: the early return on length mismatch leaks length information.
 * This is acceptable for fixed-length tokens (e.g. 32-char hex UUIDs)
 * but callers should be aware of this tradeoff for variable-length secrets.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
