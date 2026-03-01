import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Resolve the path to a persisted session secret file.
 * Defaults to `~/.openclaw/.session-secret` but respects
 * the `OPENCLAW_CONFIG_DIR` environment variable.
 */
function resolveSecretPath(): string {
  const configDir =
    process.env.OPENCLAW_CONFIG_DIR?.trim() ||
    path.join(process.env.HOME ?? process.env.USERPROFILE ?? "/tmp", ".openclaw");
  return path.join(configDir, ".session-secret");
}

/**
 * Load or generate a persistent session secret that survives process restarts.
 *
 * On first call, generates a random 32-byte hex secret and writes it to disk.
 * On subsequent calls (including after container restart), reads the persisted
 * secret from disk.
 *
 * This is intended for use by gateway wrappers (e.g. Hostinger) that need a
 * stable express-session secret across restarts (#29955).
 */
export function loadOrCreateSessionSecret(): string {
  const secretPath = resolveSecretPath();

  // Try to read existing secret
  try {
    const existing = fs.readFileSync(secretPath, "utf-8").trim();
    if (existing.length >= 32) {
      return existing;
    }
  } catch {
    // File doesn't exist or can't be read; generate a new one.
  }

  // Generate and persist
  const secret = crypto.randomBytes(32).toString("hex");
  try {
    const dir = path.dirname(secretPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(secretPath, secret, { encoding: "utf-8", mode: 0o600 });
  } catch {
    // If we can't persist, still return the generated secret for this session.
    // The next restart will generate a new one (same as current broken behavior).
  }

  return secret;
}
