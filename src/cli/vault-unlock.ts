import * as prompts from "@clack/prompts";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { decryptVault, isVaultFile } from "../security/vault.js";

const VAULT_FILENAME = "secrets.vault";

function getVaultPath(): string {
  const stateDir = resolveStateDir();
  return path.join(stateDir, VAULT_FILENAME);
}

export async function tryUnlockVault(): Promise<boolean> {
  const vaultPath = getVaultPath();

  // If no vault, nothing to unlock
  if (!isVaultFile(vaultPath)) {
    return true; // proceed as normal (legacy mode or fresh install)
  }

  // Check for environment variable key (Headless mode)
  const envKey = process.env.OPENCLAW_UNLOCK_KEY;
  if (envKey) {
    try {
      const buffer = await fs.promises.readFile(vaultPath);
      const secrets = await decryptVault(buffer, envKey);

      // Inject into process.env
      // We do this carefully to avoid overwriting existing
      for (const [key, value] of Object.entries(secrets)) {
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Failed to unlock vault with OPENCLAW_UNLOCK_KEY: " + msg);
      return false;
    }
  }

  // Interactive mode
  // We need to ensure we can prompt.
  // Note: run-main.ts runs this before parsing args, so we might be in --help or --version
  // access, but technically we need secrets even for help if plug-ins need them?
  // Actually, usually --help shouldn't require secrets.
  // But strictly speaking, if we follow "Zero Trust", the app shouldn't even boot without keys.

  prompts.intro("OpenClaw Security Vault Locked");

  const password = await prompts.password({
    message: "Enter master password to unlock secrets",
  });

  if (prompts.isCancel(password)) {
    prompts.cancel("Unlock cancelled. Exiting.");
    return false;
  }

  try {
    const buffer = await fs.promises.readFile(vaultPath);
    const secrets = await decryptVault(buffer, password);

    // Inject into process.env
    for (const [key, value] of Object.entries(secrets)) {
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }

    prompts.outro("Vault unlocked");
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    prompts.log.error("Unlock failed: " + msg);
    return false;
  }
}
