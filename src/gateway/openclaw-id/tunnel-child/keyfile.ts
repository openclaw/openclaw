// OpenClaw ID machine key files: 32 raw Ed25519 seed bytes, mode 0600. A
// group/other-readable or malformed file is refused, never replaced: a new key
// is a new endpoint id and breaks every pinned client.
//
// Once a claw is linked its stored ServerBinding names the current K_srv and
// K_gw, and `loadBoundKey` applies the start rule (enrollment.md, "Key files at
// every start"): use the key file when it holds the named key, else promote a
// staged `.next` file that holds it, else refuse. A linked claw never creates a
// key; only an unlinked one does (`loadOrCreateEndpointKey`).
import { createHash, createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const KEY_BYTES = 32;
// PKCS#8 DER prefix for a raw Ed25519 seed (RFC 8410).
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Thrown when an existing key file must not be used. */
export class KeyFileRefusedError extends Error {}

/** Why a linked claw's key could not be loaded: no file holds the key its binding names. */
export type BoundKeyRefusal = "keys_missing" | "key_mismatch";

/** Where a re-bind stages the next key for `file` until its binding is committed. */
export function stagedKeyPath(file: string): string {
  return `${file}.next`;
}

/** Loads the key at `file`, or undefined when there is no file. Never creates one. */
export function loadKeyFile(file: string): Buffer | undefined {
  if (!fs.existsSync(file)) {
    return undefined;
  }
  const stat = fs.statSync(file);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new KeyFileRefusedError(`${file} must not be group- or world-accessible`);
  }
  const key = fs.readFileSync(file);
  if (key.length !== KEY_BYTES) {
    throw new KeyFileRefusedError(`${file} is not a ${KEY_BYTES}-byte key`);
  }
  return key;
}

/** Creates a new key at `file` (directory 0700, file 0600). */
export function createKeyFile(file: string): Buffer {
  const key = randomBytes(KEY_BYTES);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, key, { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, file);
  return key;
}

/** Loads the key at `file`, creating it when missing. Only for keys no binding names yet. */
export function loadOrCreateEndpointKey(file: string): { key: Buffer; created: boolean } {
  const key = loadKeyFile(file);
  return key ? { key, created: false } : { key: createKeyFile(file), created: true };
}

/** Lowercase hex of the Ed25519 public key for a 32-byte seed (K_gw, or K_srv's iroh id). */
export function ed25519PublicKeyHex(seed: Buffer): string {
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  try {
    const jwk = createPublicKey(
      createPrivateKey({ key: der, format: "der", type: "pkcs8" }),
    ).export({ format: "jwk" });
    return Buffer.from(jwk.x ?? "", "base64url").toString("hex");
  } finally {
    der.fill(0);
  }
}

/**
 * Loads the key a linked claw's binding names (`expectedHex`, the raw public key in
 * hex). A `.next` file is promoted only when its seed derives exactly that key, so a
 * planted file is never used. Unsafe or malformed files throw KeyFileRefusedError.
 */
export function loadBoundKey(
  file: string,
  expectedHex: string,
): { key: Buffer; promoted: boolean } | { refused: BoundKeyRefusal } {
  const staged = stagedKeyPath(file);
  const current = loadKeyFile(file);
  if (current && ed25519PublicKeyHex(current) === expectedHex) {
    // A staged key of a re-bind not committed yet stays for that re-bind.
    return { key: current, promoted: false };
  }
  current?.fill(0);
  const next = loadKeyFile(staged);
  if (next && ed25519PublicKeyHex(next) === expectedHex) {
    // The binding was committed before the key was promoted: finish the re-bind.
    fs.renameSync(staged, file);
    return { key: next, promoted: true };
  }
  next?.fill(0);
  return { refused: current ? "key_mismatch" : "keys_missing" };
}

/** Short non-secret label for logs: `fp:` + 8 hex of SHA-256 over the raw key. */
export function logFingerprint(hexId: string): string {
  const raw = /^[0-9a-f]{64}$/.test(hexId) ? Buffer.from(hexId, "hex") : Buffer.from(hexId);
  return `fp:${createHash("sha256").update(raw).digest("hex").slice(0, 8)}`;
}
