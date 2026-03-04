/**
 * TOTP (Time-based One-Time Password) validator.
 * Pure TypeScript implementation using Node.js crypto.
 *
 * RFC 6238 compliant:
 * - HMAC-SHA1 based
 * - 6-digit codes
 * - 30-second time step
 * - ±1 step drift tolerance
 */

import crypto from "node:crypto";

const TIME_STEP = 30; // seconds
const CODE_DIGITS = 6;
const DRIFT_STEPS = 1; // Allow ±1 step (±30s)

/**
 * Base32 character set (RFC 4648).
 */
const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Decode a Base32-encoded string to Buffer.
 * @param encoded Base32 string (case-insensitive, spaces/dashes ignored)
 * @returns Decoded buffer
 */
export function base32Decode(encoded: string): Buffer {
  // Normalize: uppercase, remove spaces and dashes
  const clean = encoded.toUpperCase().replace(/[\s-]/g, "");

  let bits = "";
  for (const char of clean) {
    const index = BASE32_CHARS.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid Base32 character: ${char}`);
    }
    bits += index.toString(2).padStart(5, "0");
  }

  // Convert bit string to bytes
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  }

  return Buffer.from(bytes);
}

/**
 * Generate HMAC-SHA1 hash.
 */
function hmacSha1(key: Buffer, message: Buffer): Buffer {
  return crypto.createHmac("sha1", key).update(message).digest();
}

/**
 * Generate a TOTP code for a given time counter.
 * @param secret Base32-encoded secret key
 * @param counter Time counter (typically Unix timestamp / 30)
 * @returns 6-digit TOTP code
 */
function generateTotpForCounter(secret: string, counter: number): string {
  const key = base32Decode(secret);

  // Create 8-byte counter buffer (big-endian)
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  // Generate HMAC
  const hmac = hmacSha1(key, counterBuffer);

  // Dynamic truncation (RFC 4226)
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];

  // Generate 6-digit code
  const code = binary % Math.pow(10, CODE_DIGITS);
  return code.toString().padStart(CODE_DIGITS, "0");
}

/**
 * Generate a TOTP code for the current time.
 * @param secret Base32-encoded secret key
 * @returns 6-digit TOTP code
 */
export function generateTotp(secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const counter = Math.floor(now / TIME_STEP);
  return generateTotpForCounter(secret, counter);
}

/**
 * Validate a TOTP code against a secret.
 * Allows for ±1 time step drift (±30 seconds).
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * @param secret Base32-encoded secret key
 * @param code 6-digit code to validate
 * @returns true if code is valid
 */
export function validateTotp(secret: string, code: string): boolean {
  const cleanCode = code.trim().replace(/\s/g, "");

  if (cleanCode.length !== CODE_DIGITS) {
    return false;
  }

  if (!/^\d+$/.test(cleanCode)) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  const currentCounter = Math.floor(now / TIME_STEP);

  // Check current time step and ±DRIFT_STEPS
  for (let drift = -DRIFT_STEPS; drift <= DRIFT_STEPS; drift++) {
    const counter = currentCounter + drift;
    try {
      const expected = generateTotpForCounter(secret, counter);

      // Timing-safe comparison: both buffers must be same length
      if (expected.length === cleanCode.length) {
        const expectedBuf = Buffer.from(expected, "utf8");
        const providedBuf = Buffer.from(cleanCode, "utf8");
        if (crypto.timingSafeEqual(expectedBuf, providedBuf)) {
          return true;
        }
      }
    } catch {
      // Invalid secret or decode error
      continue;
    }
  }

  return false;
}

/**
 * Validate TOTP code with custom time step and drift.
 * For testing or alternative configurations.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function validateTotpCustom(
  secret: string,
  code: string,
  options?: {
    timeStep?: number;
    drift?: number;
    timestamp?: number; // Unix timestamp (defaults to now)
  },
): boolean {
  const cleanCode = code.trim().replace(/\s/g, "");
  const timeStep = options?.timeStep ?? TIME_STEP;
  const drift = options?.drift ?? DRIFT_STEPS;
  const timestamp = options?.timestamp ?? Math.floor(Date.now() / 1000);

  if (cleanCode.length !== CODE_DIGITS || !/^\d+$/.test(cleanCode)) {
    return false;
  }

  const currentCounter = Math.floor(timestamp / timeStep);

  for (let d = -drift; d <= drift; d++) {
    const counter = currentCounter + d;
    try {
      const expected = generateTotpForCounter(secret, counter);

      // Timing-safe comparison
      if (expected.length === cleanCode.length) {
        const expectedBuf = Buffer.from(expected, "utf8");
        const providedBuf = Buffer.from(cleanCode, "utf8");
        if (crypto.timingSafeEqual(expectedBuf, providedBuf)) {
          return true;
        }
      }
    } catch {
      continue;
    }
  }

  return false;
}
