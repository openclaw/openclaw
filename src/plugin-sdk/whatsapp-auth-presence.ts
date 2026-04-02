import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { WhatsAppAccountConfig, WhatsAppConfig } from "../config/types.whatsapp.js";
import { resolveOAuthDir } from "../config/paths.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
import { isRecord, resolveUserPath } from "../utils.js";

function hasWebCredsSync(authDir: string): boolean {
  try {
    return fs.existsSync(path.join(authDir, "creds.json"));
  } catch {
    return false;
  }
}

function resolveWhatsAppChannelConfig(cfg: OpenClawConfig): WhatsAppConfig | undefined {
  return cfg.channels?.whatsapp;
}

function addAccountAuthDirs(
  authDirs: Set<string>,
  accountId: string,
  account: WhatsAppAccountConfig | undefined,
  accountsRoot: string,
  env: NodeJS.ProcessEnv,
): void {
  authDirs.add(path.join(accountsRoot, normalizeAccountId(accountId)));
  const configuredAuthDir = account?.authDir?.trim();
  if (configuredAuthDir) {
    authDirs.add(resolveUserPath(configuredAuthDir, env));
  }
}

function listWhatsAppAuthDirs(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const oauthDir = resolveOAuthDir(env);
  const accountsRoot = path.join(oauthDir, "whatsapp");
  const channel = resolveWhatsAppChannelConfig(cfg);
  const authDirs = new Set<string>([oauthDir, path.join(accountsRoot, DEFAULT_ACCOUNT_ID)]);

  addAccountAuthDirs(authDirs, DEFAULT_ACCOUNT_ID, undefined, accountsRoot, env);

  if (channel?.defaultAccount?.trim()) {
    addAccountAuthDirs(
      authDirs,
      channel.defaultAccount,
      channel.accounts?.[channel.defaultAccount],
      accountsRoot,
      env,
    );
  }

  const accounts = channel?.accounts;
  if (isRecord(accounts)) {
    for (const [accountId, value] of Object.entries(accounts)) {
      addAccountAuthDirs(
        authDirs,
        accountId,
        isRecord(value) ? value : undefined,
        accountsRoot,
        env,
      );
    }
  }

  try {
    const entries = fs.readdirSync(accountsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        authDirs.add(path.join(accountsRoot, entry.name));
      }
    }
  } catch {
    // Missing directories are equivalent to no auth state.
  }

  return [...authDirs];
}

export function hasAnyWhatsAppAuth(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return listWhatsAppAuthDirs(cfg, env).some((authDir) => hasWebCredsSync(authDir));
}
