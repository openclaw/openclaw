import { pbkdf2, randomBytes } from "node:crypto";

const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_DIGEST = "sha512";
const KEY_LENGTH = 32;
const SALT_LENGTH = 32;

export function generateSalt(): Buffer {
  return randomBytes(SALT_LENGTH);
}

/** Derive a 256-bit key from a passphrase using PBKDF2-SHA512 with 600k iterations. */
export function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    pbkdf2(passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH, PBKDF2_DIGEST, (err, key) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(key);
    });
  });
}

/** Resolve a vault passphrase from env or explicit option. */
export function resolvePassphrase(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (explicit) {
    return explicit;
  }
  return env.OPENCLAW_VAULT_PASSPHRASE?.trim() || undefined;
}
