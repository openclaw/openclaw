import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveOAuthDir } from "../config/paths.js";
import { info, success } from "../globals.js";
import {
  readPossiblyEncryptedFile,
  writePossiblyEncryptedFile,
  migrateFileToEncrypted,
} from "../infra/secrets-manager.js";
import { getChildLogger } from "../logging.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { WebChannel } from "../utils.js";
import { jidToE164, resolveUserPath } from "../utils.js";

export function resolveDefaultWebAuthDir(): string {
  return path.join(resolveOAuthDir(), "whatsapp", DEFAULT_ACCOUNT_ID);
}

export const WA_WEB_AUTH_DIR = resolveDefaultWebAuthDir();

export function resolveWebCredsPath(authDir: string): string {
  return path.join(authDir, "creds.json");
}

export function resolveWebCredsEncryptedPath(authDir: string): string {
  return path.join(authDir, "creds.json.enc");
}

export function resolveWebCredsBackupPath(authDir: string): string {
  return path.join(authDir, "creds.json.bak");
}

export function resolveWebCredsBackupEncryptedPath(authDir: string): string {
  return path.join(authDir, "creds.json.bak.enc");
}

export function hasWebCredsSync(authDir: string): boolean {
  // Check encrypted version first (preferred)
  const encryptedPath = resolveWebCredsEncryptedPath(authDir);
  try {
    const stats = fsSync.statSync(encryptedPath);
    if (stats.isFile() && stats.size > 1) return true;
  } catch {
    // Continue to check plaintext
  }

  // Fall back to plaintext version
  try {
    const stats = fsSync.statSync(resolveWebCredsPath(authDir));
    return stats.isFile() && stats.size > 1;
  } catch {
    return false;
  }
}

/**
 * Reads credentials from a file, supporting both encrypted and plaintext formats.
 * Prefers the encrypted version (.enc) if it exists.
 */
function readCredsJsonRaw(filePath: string): string | null {
  // Use the secrets-manager utility to handle encrypted/plaintext transparently
  const result = readPossiblyEncryptedFile(filePath);
  if (result.content === null) return null;

  // Validate content has meaningful size
  if (result.content.length <= 1) return null;

  return result.content;
}

export function maybeRestoreCredsFromBackup(authDir: string): void {
  const logger = getChildLogger({ module: "web-session" });
  try {
    const credsPath = resolveWebCredsPath(authDir);
    const backupPath = resolveWebCredsBackupPath(authDir);
    const raw = readCredsJsonRaw(credsPath);
    if (raw) {
      // Validate that creds.json is parseable.
      JSON.parse(raw);
      return;
    }

    // Try plaintext backup first
    const backupRaw = readCredsJsonRaw(backupPath);
    if (backupRaw) {
      // Ensure backup is parseable before restoring.
      JSON.parse(backupRaw);
      // Check if backup is encrypted (.bak.enc exists) or plaintext (.bak exists)
      const encBackupPath = resolveWebCredsBackupEncryptedPath(authDir);
      if (fsSync.existsSync(encBackupPath)) {
        // Encrypted backup -> restore to encrypted creds
        const encCredsPath = resolveWebCredsEncryptedPath(authDir);
        fsSync.copyFileSync(encBackupPath, encCredsPath);
        logger.warn(
          { credsPath: encCredsPath },
          "restored WhatsApp creds.json.enc from encrypted backup",
        );
      } else if (fsSync.existsSync(backupPath)) {
        // Plaintext backup -> restore to plaintext creds
        fsSync.copyFileSync(backupPath, credsPath);
        logger.warn({ credsPath }, "restored WhatsApp creds.json from backup");
      }
      return;
    }

    // If readCredsJsonRaw returned null but encrypted backup exists, try direct copy
    const encBackupPath = resolveWebCredsBackupEncryptedPath(authDir);
    if (fsSync.existsSync(encBackupPath)) {
      const encCredsPath = resolveWebCredsEncryptedPath(authDir);
      fsSync.copyFileSync(encBackupPath, encCredsPath);
      logger.warn(
        { credsPath: encCredsPath },
        "restored WhatsApp creds.json.enc from encrypted backup",
      );
    }
  } catch {
    // ignore
  }
}

export async function webAuthExists(authDir: string = resolveDefaultWebAuthDir()) {
  const resolvedAuthDir = resolveUserPath(authDir);
  maybeRestoreCredsFromBackup(resolvedAuthDir);
  const credsPath = resolveWebCredsPath(resolvedAuthDir);

  try {
    await fs.access(resolvedAuthDir);
  } catch {
    return false;
  }

  // Check encrypted version first (preferred)
  const encryptedPath = resolveWebCredsEncryptedPath(resolvedAuthDir);
  try {
    const stats = await fs.stat(encryptedPath);
    if (stats.isFile() && stats.size > 1) {
      // Validate by attempting to decrypt and parse
      const result = readPossiblyEncryptedFile(credsPath);
      if (result.content) {
        JSON.parse(result.content);
        return true;
      }
    }
  } catch {
    // Continue to check plaintext
  }

  // Fall back to plaintext version
  try {
    const stats = await fs.stat(credsPath);
    if (!stats.isFile() || stats.size <= 1) return false;
    const raw = await fs.readFile(credsPath, "utf-8");
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

async function clearLegacyBaileysAuthState(authDir: string) {
  const entries = await fs.readdir(authDir, { withFileTypes: true });
  const shouldDelete = (name: string) => {
    if (name === "oauth.json") return false;
    // Include encrypted versions for cleanup
    if (
      name === "creds.json" ||
      name === "creds.json.bak" ||
      name === "creds.json.enc" ||
      name === "creds.json.bak.enc"
    )
      return true;
    if (!name.endsWith(".json") && !name.endsWith(".enc")) return false;
    return /^(app-state-sync|session|sender-key|pre-key)-/.test(name);
  };
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile()) return;
      if (!shouldDelete(entry.name)) return;
      await fs.rm(path.join(authDir, entry.name), { force: true });
    }),
  );
}

/**
 * Migrates plaintext WhatsApp credentials to encrypted storage.
 * Returns true if migration occurred, false if already encrypted or no creds exist.
 */
export function migrateWebCredsToEncrypted(authDir: string = resolveDefaultWebAuthDir()): {
  migrated: boolean;
  error?: string;
} {
  const logger = getChildLogger({ module: "web-session" });
  const resolvedAuthDir = resolveUserPath(authDir);
  const credsPath = resolveWebCredsPath(resolvedAuthDir);
  const backupPath = resolveWebCredsBackupPath(resolvedAuthDir);

  // Check if already encrypted
  if (fsSync.existsSync(resolveWebCredsEncryptedPath(resolvedAuthDir))) {
    logger.info({ authDir: resolvedAuthDir }, "WhatsApp credentials already encrypted");
    return { migrated: false };
  }

  // Check if plaintext exists
  if (!fsSync.existsSync(credsPath)) {
    return { migrated: false };
  }

  try {
    // Migrate main credentials
    const encryptedPath = migrateFileToEncrypted(credsPath, { removeOriginal: true });
    if (!encryptedPath) {
      return { migrated: false, error: "Failed to encrypt credentials file" };
    }

    // Also migrate backup if it exists
    if (fsSync.existsSync(backupPath)) {
      migrateFileToEncrypted(backupPath, { removeOriginal: true });
    }

    logger.info({ authDir: resolvedAuthDir }, "Migrated WhatsApp credentials to encrypted storage");
    return { migrated: true };
  } catch (err) {
    logger.error(
      { authDir: resolvedAuthDir, error: String(err) },
      "Failed to migrate WhatsApp credentials",
    );
    return { migrated: false, error: String(err) };
  }
}

/**
 * Writes WhatsApp credentials to encrypted storage.
 */
export function writeWebCreds(
  authDir: string,
  creds: unknown,
  opts: { encrypt?: boolean } = {},
): boolean {
  const resolvedAuthDir = resolveUserPath(authDir);
  const credsPath = resolveWebCredsPath(resolvedAuthDir);
  const content = JSON.stringify(creds, null, 2);

  const result = writePossiblyEncryptedFile(credsPath, content, {
    encrypt: opts.encrypt !== false,
    removePlaintext: true,
  });

  return result !== null;
}

export async function logoutWeb(params: {
  authDir?: string;
  isLegacyAuthDir?: boolean;
  runtime?: RuntimeEnv;
}) {
  const runtime = params.runtime ?? defaultRuntime;
  const resolvedAuthDir = resolveUserPath(params.authDir ?? resolveDefaultWebAuthDir());
  const exists = await webAuthExists(resolvedAuthDir);
  if (!exists) {
    runtime.log(info("No WhatsApp Web session found; nothing to delete."));
    return false;
  }
  if (params.isLegacyAuthDir) {
    await clearLegacyBaileysAuthState(resolvedAuthDir);
  } else {
    // Remove both encrypted and plaintext versions
    await fs.rm(resolvedAuthDir, { recursive: true, force: true });
  }
  runtime.log(success("Cleared WhatsApp Web credentials (including encrypted)."));
  return true;
}

export function readWebSelfId(authDir: string = resolveDefaultWebAuthDir()) {
  // Read the cached WhatsApp Web identity (jid + E.164) from disk if present.
  // Supports both encrypted and plaintext credentials.
  try {
    const credsPath = resolveWebCredsPath(resolveUserPath(authDir));
    const result = readPossiblyEncryptedFile(credsPath);
    if (!result.content) {
      return { e164: null, jid: null } as const;
    }
    const parsed = JSON.parse(result.content) as { me?: { id?: string } } | undefined;
    const jid = parsed?.me?.id ?? null;
    const e164 = jid ? jidToE164(jid, { authDir }) : null;
    return { e164, jid } as const;
  } catch {
    return { e164: null, jid: null } as const;
  }
}

/**
 * Return the age (in milliseconds) of the cached WhatsApp web auth state, or null when missing.
 * Helpful for heartbeats/observability to spot stale credentials.
 * Checks encrypted version first, then falls back to plaintext.
 */
export function getWebAuthAgeMs(authDir: string = resolveDefaultWebAuthDir()): number | null {
  const resolvedAuthDir = resolveUserPath(authDir);

  // Check encrypted version first (preferred)
  try {
    const stats = fsSync.statSync(resolveWebCredsEncryptedPath(resolvedAuthDir));
    return Date.now() - stats.mtimeMs;
  } catch {
    // Continue to check plaintext
  }

  // Fall back to plaintext version
  try {
    const stats = fsSync.statSync(resolveWebCredsPath(resolvedAuthDir));
    return Date.now() - stats.mtimeMs;
  } catch {
    return null;
  }
}

export function logWebSelfId(
  authDir: string = resolveDefaultWebAuthDir(),
  runtime: RuntimeEnv = defaultRuntime,
  includeChannelPrefix = false,
) {
  // Human-friendly log of the currently linked personal web session.
  const { e164, jid } = readWebSelfId(authDir);
  const details = e164 || jid ? `${e164 ?? "unknown"}${jid ? ` (jid ${jid})` : ""}` : "unknown";
  const prefix = includeChannelPrefix ? "Web Channel: " : "";
  runtime.log(info(`${prefix}${details}`));
}

export async function pickWebChannel(
  pref: WebChannel | "auto",
  authDir: string = resolveDefaultWebAuthDir(),
): Promise<WebChannel> {
  const choice: WebChannel = pref === "auto" ? "web" : pref;
  const hasWeb = await webAuthExists(authDir);
  if (!hasWeb) {
    throw new Error(
      `No WhatsApp Web session found. Run \`${formatCliCommand("moltbot channels login --channel whatsapp --verbose")}\` to link.`,
    );
  }
  return choice;
}
