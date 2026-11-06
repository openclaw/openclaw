// The tunnel endpoint secret key: 32 raw bytes, mode 0600, created on first
// start. A group/other-readable or malformed file is refused, never replaced:
// a new key is a new endpoint id and breaks every pinned client.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const KEY_BYTES = 32;

/** Thrown when an existing key file must not be used. */
export class KeyFileRefusedError extends Error {}

/** Loads the key at `file`, creating it (directory 0700, file 0600) when missing. */
export function loadOrCreateEndpointKey(file: string): { key: Buffer; created: boolean } {
  if (fs.existsSync(file)) {
    const stat = fs.statSync(file);
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new KeyFileRefusedError(`${file} must not be group- or world-accessible`);
    }
    const key = fs.readFileSync(file);
    if (key.length !== KEY_BYTES) {
      throw new KeyFileRefusedError(`${file} is not a ${KEY_BYTES}-byte key`);
    }
    return { key, created: false };
  }
  const key = randomBytes(KEY_BYTES);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, key, { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, file);
  return { key, created: true };
}

/** Short non-secret label for logs: `fp:` + 8 hex of SHA-256 over the raw key. */
export function logFingerprint(hexId: string): string {
  const raw = /^[0-9a-f]{64}$/.test(hexId) ? Buffer.from(hexId, "hex") : Buffer.from(hexId);
  return `fp:${createHash("sha256").update(raw).digest("hex").slice(0, 8)}`;
}
