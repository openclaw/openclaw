/**
 * Constant-time secret comparison (CWE-208: Observable Timing Discrepancy).
 *
 * Threat model:
 *   A naive `provided === expected` comparison leaks the length of the common
 *   prefix via timing: the comparison returns early as soon as a mismatch is
 *   found, so an attacker who can measure response latency can brute-force
 *   secrets one character at a time.
 *
 * Why hash before comparing:
 *   `crypto.timingSafeEqual(a, b)` requires both buffers to have the same
 *   byte length.  Rather than padding or truncating, we hash both inputs with
 *   SHA-256 so the buffers are always exactly 32 bytes.  Hashing also ensures
 *   that even if the comparison were somehow non-constant-time at the CPU
 *   level, the attacker learns nothing about the original secret — only about
 *   the hash, which is a one-way function.
 *
 * Note: SHA-256 is not a password KDF (use bcrypt/argon2 for passwords).
 * This function is for API keys and webhook secrets that are already
 * high-entropy random strings.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export function safeEqualSecret(
  provided: string | undefined | null,
  expected: string | undefined | null,
): boolean {
  if (typeof provided !== "string" || typeof expected !== "string") {
    return false;
  }
  const hash = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(hash(provided), hash(expected));
}
