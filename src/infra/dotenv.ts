import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { isVaultFile } from "../security/vault.js";
import { resolveConfigDir } from "../utils.js";

export function loadDotEnv(opts?: { quiet?: boolean }) {
  const quiet = opts?.quiet ?? true;

  // Check for Vault existence to prevent confusion
  const vaultPath = path.join(resolveStateDir(process.env), "secrets.vault");

  if (isVaultFile(vaultPath)) {
    // If vault exists, we avoid loading .env to ensure Zero Trust compliance
    // unless explicitly forced (which we don't support yet, to be strict).
    // We just warn if we see a .env file.
    if (fs.existsSync(".env")) {
      console.warn(
        "[openclaw] Security Warning: .env file found but secrets.vault exists. Ignoring .env.",
      );
    }
    return;
  }

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
