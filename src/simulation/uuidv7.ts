import { randomBytes } from "node:crypto";

/**
 * Generate a UUIDv7 (RFC 9562) using Node.js built-ins.
 * 48-bit big-endian ms timestamp + version 7 + variant 10 + random fill.
 */
export function uuidv7(): string {
  const now = Date.now();
  const timeBytes = Buffer.alloc(6);
  timeBytes.writeUIntBE(now, 0, 6);
  const rand = randomBytes(10);
  // version 7 (0111xxxx)
  rand[0] = (rand[0] & 0x0f) | 0x70;
  // variant 10 (10xxxxxx)
  rand[2] = (rand[2] & 0x3f) | 0x80;
  const hex = Buffer.concat([timeBytes, rand]).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
