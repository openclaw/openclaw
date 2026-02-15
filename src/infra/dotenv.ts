import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { resolveConfigDir } from "../utils.js";
import { loadVaultEnv } from "./env-vault.js";

export function loadDotEnv(opts?: { quiet?: boolean }) {
  const quiet = opts?.quiet ?? true;

  // Load from process CWD first (dotenv default).
  dotenv.config({ quiet });

  // Then load global fallback: ~/.openclaw/.env (or OPENCLAW_STATE_DIR/.env),
  // without overriding any env vars already present.
  const globalEnvPath = path.join(resolveConfigDir(process.env), ".env");
  if (!fs.existsSync(globalEnvPath)) {
    return;
  }

  dotenv.config({ quiet, path: globalEnvPath, override: false });
}

/**
 * Extension of loadDotEnv that also loads secrets from the encrypted vault.
 * The vault layer runs AFTER local .env files so local values take
 * precedence (matching the existing "don't override" convention).
 *
 * This is fully synchronous (no async gap) and is a no-op when
 * OPENCLAW_VAULT_PASSWORD is not set.
 */
export function loadDotEnvWithVault(opts?: { quiet?: boolean }): { vaultApplied: number } {
  loadDotEnv(opts);

  const vaultApplied = loadVaultEnv();

  return { vaultApplied };
}
