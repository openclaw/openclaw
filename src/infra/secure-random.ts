import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { v7 as uuidV7 } from "uuid";

export function generateSecureUuid(): string {
  return randomUUID();
}

/**
 * Returns a UUIDv7 (RFC 9562) — time-ordered 128-bit identifier whose
 * first 48 bits are the unix-milliseconds timestamp at mint time. Used
 * for `SessionEntry.continuationChainId`: chain.id is minted on the 0->1
 * transition of `continuationChainCount` and stays stable for the lifetime of
 * the chain, so journal greps + sort-by-id give chronological order without a
 * separate timestamp lookup.
 *
 * Why v7 and not v4: lexicographic ordering preserved across mints,
 * downstream OTEL collectors (Jaeger/Tempo) parse UUID-shape natively,
 * and `uuid@14` is already a direct dependency.
 */
export function generateChainId(): string {
  return uuidV7();
}

export function generateSecureToken(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}

export function generateSecureHex(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

/** Returns a cryptographically secure fraction in the range [0, 1). */
export function generateSecureFraction(): number {
  return randomBytes(4).readUInt32BE(0) / 0x1_0000_0000;
}

export function generateSecureInt(maxExclusive: number): number;
export function generateSecureInt(minInclusive: number, maxExclusive: number): number;
export function generateSecureInt(a: number, b?: number): number {
  return typeof b === "number" ? randomInt(a, b) : randomInt(a);
}
