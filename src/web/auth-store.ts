import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveOAuthDir } from "../config/paths.js";
import { info, success } from "../globals.js";
import { getChildLogger } from "../logging.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import type { WebChannel } from "../utils.js";
import { jidToE164, resolveUserPath } from "../utils.js";

export function resolveDefaultWebAuthDir(): string {
  return path.join(resolveOAuthDir(), "whatsapp", DEFAULT_ACCOUNT_ID);
}

export const WA_WEB_AUTH_DIR = resolveDefaultWebAuthDir();

export function resolveWebCredsPath(authDir: string): string {
  return path.join(authDir, "creds.json");
}

export function resolveWebCredsBackupPath(authDir: string): string {
  return path.join(authDir, "creds.json.bak");
}

export function hasWebCredsSync(authDir: string): boolean {
  try {
    const stats = fsSync.statSync(resolveWebCredsPath(authDir));
    return stats.isFile() && stats.size > 1;
  } catch {
    return false;
  }
}

export function readCredsJsonRaw(filePath: string): string | null {
  try {
    if (!fsSync.existsSync(filePath)) {
      return null;
    }
    const stats = fsSync.statSync(filePath);
    if (!stats.isFile() || stats.size <= 1) {
      return null;
    }
    return fsSync.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
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

    const backupRaw = readCredsJsonRaw(backupPath);
    if (!backupRaw) {
      return;
    }

    // Ensure backup is parseable before restoring.
    JSON.parse(backupRaw);
    fsSync.copyFileSync(backupPath, credsPath);
    try {
      fsSync.chmodSync(credsPath, 0o600);
    } catch {
      // best-effort on platforms that support it
    }
    logger.warn({ credsPath }, "restored corrupted WhatsApp creds.json from backup");
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
  try {
    const stats = await fs.stat(credsPath);
    if (!stats.isFile() || stats.size <= 1) {
      return false;
    }
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
    if (name === "oauth.json") {
      return false;
    }
    if (name === "creds.json" || name === "creds.json.bak") {
      return true;
    }
    if (!name.endsWith(".json")) {
      return false;
    }
    return /^(app-state-sync|session|sender-key|pre-key)-/.test(name);
  };
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile()) {
        return;
      }
      if (!shouldDelete(entry.name)) {
        return;
      }
      await fs.rm(path.join(authDir, entry.name), { force: true });
    }),
  );
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
    await fs.rm(resolvedAuthDir, { recursive: true, force: true });
  }
  runtime.log(success("Cleared WhatsApp Web credentials."));
  return true;
}

export function readWebSelfId(authDir: string = resolveDefaultWebAuthDir()) {
  // Read the cached WhatsApp Web identity (jid + E.164) from disk if present.
  try {
    const credsPath = resolveWebCredsPath(resolveUserPath(authDir));
    if (!fsSync.existsSync(credsPath)) {
      return { e164: null, jid: null } as const;
    }
    const raw = fsSync.readFileSync(credsPath, "utf-8");
    const parsed = JSON.parse(raw) as { me?: { id?: string } } | undefined;
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
 */
export function getWebAuthAgeMs(authDir: string = resolveDefaultWebAuthDir()): number | null {
  try {
    const stats = fsSync.statSync(resolveWebCredsPath(resolveUserPath(authDir)));
    return Date.now() - stats.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Maximum number of credential files before triggering pruning.
 * Baileys generates pre-key files on each reconnect; unbounded growth leads to
 * session corruption after 2-3 weeks (~7000+ files). See issue #19618.
 */
const CREDENTIAL_FILE_THRESHOLD = 500;

/**
 * Number of recent pre-key files to retain after pruning.
 * Keeping some history allows for brief reconnect races.
 */
const PREKEY_FILES_TO_KEEP = 100;

/**
 * Prune stale pre-key and session files from the WhatsApp credential store.
 * Baileys accumulates pre-key files on each reconnect without cleanup, eventually
 * corrupting the session. This function removes the oldest files when the count
 * exceeds CREDENTIAL_FILE_THRESHOLD, keeping the most recent PREKEY_FILES_TO_KEEP.
 *
 * Safe to call on every gateway start or reconnect.
 *
 * @returns Object with pruned count and remaining count, or null if no pruning needed.
 */
export async function pruneStaleCredentials(
  authDir: string = resolveDefaultWebAuthDir(),
): Promise<{ pruned: number; remaining: number } | null> {
  const logger = getChildLogger({ module: "web-auth-prune" });
  const resolvedAuthDir = resolveUserPath(authDir);

  try {
    await fs.access(resolvedAuthDir);
  } catch {
    return null; // Directory doesn't exist
  }

  const isPrunableFile = (name: string): boolean => {
    // Only prune pre-key, sender-key, and session files (not creds.json or app-state)
    if (!name.endsWith(".json")) {
      return false;
    }
    return /^(pre-key|sender-key|session)-/.test(name);
  };

  try {
    const entries = await fs.readdir(resolvedAuthDir, { withFileTypes: true });
    const allFiles = entries.filter((e) => e.isFile());
    const prunableFiles: { name: string; mtimeMs: number }[] = [];

    // Gather prunable files with their modification times
    for (const entry of allFiles) {
      if (!isPrunableFile(entry.name)) {
        continue;
      }
      try {
        const stats = await fs.stat(path.join(resolvedAuthDir, entry.name));
        prunableFiles.push({ name: entry.name, mtimeMs: stats.mtimeMs });
      } catch {
        // Skip files we can't stat
      }
    }

    const totalFiles = allFiles.length;

    // Only prune if prunable files exceed the threshold
    if (prunableFiles.length <= CREDENTIAL_FILE_THRESHOLD) {
      return null;
    }

    // Sort by modification time, oldest first
    prunableFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);

    // Calculate how many to delete (keep the most recent PREKEY_FILES_TO_KEEP)
    const toDelete = prunableFiles.slice(
      0,
      Math.max(0, prunableFiles.length - PREKEY_FILES_TO_KEEP),
    );

    if (toDelete.length === 0) {
      return null;
    }

    // Delete old files
    let deletedCount = 0;
    for (const file of toDelete) {
      try {
        await fs.rm(path.join(resolvedAuthDir, file.name), { force: true });
        deletedCount++;
      } catch {
        // Continue on individual file errors
      }
    }

    const remaining = totalFiles - deletedCount;
    logger.info(
      { pruned: deletedCount, remaining, threshold: CREDENTIAL_FILE_THRESHOLD },
      "pruned stale WhatsApp credential files",
    );

    return { pruned: deletedCount, remaining };
  } catch (err) {
    logger.warn({ err }, "failed to prune WhatsApp credentials");
    return null;
  }
}

/**
 * Get the current credential file count for diagnostics.
 */
export function getCredentialFileCount(authDir: string = resolveDefaultWebAuthDir()): number {
  try {
    const resolvedAuthDir = resolveUserPath(authDir);
    const entries = fsSync.readdirSync(resolvedAuthDir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).length;
  } catch {
    return 0;
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
      `No WhatsApp Web session found. Run \`${formatCliCommand("openclaw channels login --channel whatsapp --verbose")}\` to link.`,
    );
  }
  return choice;
}
