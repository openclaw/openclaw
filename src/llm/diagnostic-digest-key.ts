// Per-install keyed digest for bounded diagnostic content.
//
// A content-derived digest confirms guessed content when it is published: an
// observer holding the digest can test candidate buffers and learn which one was
// rejected. Keying the digest with a per-install secret removes that oracle,
// while keeping the digest stable for the lifetime of the install so an
// operator can still tell a repeated rejection from a new one.
//
// The secret lives in the state directory beside the other install-scoped
// material, is created once with 0600, and is never logged or exported.

import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/state-dir.js";

const DIAGNOSTIC_DIGEST_KEY_FILENAME = "diagnostic-digest.key";
const DIAGNOSTIC_DIGEST_KEY_BYTES = 32;
const DIAGNOSTIC_DIGEST_HEX_CHARS = 12;

let cachedKey: Buffer | undefined;

/** Loads the install-scoped digest secret, creating it on first use. */
function loadDiagnosticDigestKey(): Buffer | undefined {
  if (cachedKey) {
    return cachedKey;
  }
  try {
    const stateDir = resolveStateDir();
    const keyPath = path.join(stateDir, DIAGNOSTIC_DIGEST_KEY_FILENAME);
    let key: Buffer;
    try {
      key = readFileSync(keyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const created = randomBytes(DIAGNOSTIC_DIGEST_KEY_BYTES);
      try {
        // Exclusive create so a concurrent writer never observes a partial key.
        writeFileSync(keyPath, created, { flag: "wx", mode: 0o600 });
        key = created;
      } catch (createError) {
        if ((createError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw createError;
        }
        key = readFileSync(keyPath);
      }
    }
    if (key.length !== DIAGNOSTIC_DIGEST_KEY_BYTES) {
      throw new Error("Invalid diagnostic digest key");
    }
    chmodSync(keyPath, 0o600);
    cachedKey = key;
    return key;
  } catch {
    // Without a usable secret the caller keeps the unkeyed digest rather than
    // failing the turn that happened to reject a tool call.
    return undefined;
  }
}

/**
 * Derives a keyed digest for bounded diagnostic content. Returns undefined when
 * no install-scoped secret is available, so the caller can fall back.
 */
export function hashDiagnosticValue(value: string): string | undefined {
  const key = loadDiagnosticDigestKey();
  if (!key) {
    return undefined;
  }
  return createHmac("sha256", key)
    .update(value)
    .digest("hex")
    .slice(0, DIAGNOSTIC_DIGEST_HEX_CHARS);
}
