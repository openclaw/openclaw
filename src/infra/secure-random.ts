import { randomBytes, randomInt, randomUUID } from "node:crypto";

/** Generate a cryptographically secure UUID using Node's native UUID source. */
export function generateSecureUuid(): string {
  return randomUUID();
}

/** Generate a base64url token with the requested random byte length. */
export function generateSecureToken(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}

/** Generate a lowercase hex token with two output characters per random byte. */
export function generateSecureHex(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

/** Returns a cryptographically secure fraction in the range [0, 1). */
export function generateSecureFraction(): number {
  return randomBytes(4).readUInt32BE(0) / 0x1_0000_0000;
}

/** Generate a cryptographically secure integer in Node randomInt's exclusive range. */
export function generateSecureInt(maxExclusive: number): number;
export function generateSecureInt(minInclusive: number, maxExclusive: number): number;
export function generateSecureInt(a: number, b?: number): number {
  return typeof b === "number" ? randomInt(a, b) : randomInt(a);
}
