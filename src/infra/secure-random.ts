// Provides secure random ids and bounded random numbers.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";

/** Generates a cryptographically secure UUID for runtime ids and cache keys. */
export function generateSecureUuid(): string {
  return randomUUID();
}

/** Generates a URL-safe cryptographic token from the requested byte count. */
export function generateSecureToken(options: { bytes?: number; redact: true }): string;
export function generateSecureToken(bytes?: number): string;
export function generateSecureToken(input: number | { bytes?: number; redact: true } = 16): string {
  const bytes = typeof input === "number" ? input : (input.bytes ?? 16);
  // The object form records secrecy at the producer. Older numeric-only hosts
  // reject this form instead of silently ignoring a redaction request.
  if (typeof input !== "number" && bytes < 16) {
    throw new RangeError("Redacted tokens require at least 16 bytes");
  }
  const token = randomBytes(bytes).toString("base64url");
  if (typeof input !== "number") {
    registerSecretValueForRedaction(token);
  }
  return token;
}

/** Generates a hex-encoded cryptographic token from the requested byte count. */
export function generateSecureHex(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

/** Returns a cryptographically secure fraction in the range [0, 1). */
export function generateSecureFraction(): number {
  return randomBytes(4).readUInt32BE(0) / 0x1_0000_0000;
}

/** Generates a cryptographically secure integer in `[0, maxExclusive)`. */
export function generateSecureInt(maxExclusive: number): number;
/** Generates a cryptographically secure integer in `[minInclusive, maxExclusive)`. */
export function generateSecureInt(minInclusive: number, maxExclusive: number): number;
export function generateSecureInt(a: number, b?: number): number {
  return typeof b === "number" ? randomInt(a, b) : randomInt(a);
}
