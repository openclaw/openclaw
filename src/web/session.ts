import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";

import { resolveDefaultSessionStorePath } from "../config/sessions.js";
import { danger, info, success } from "../globals.js";
import { getChildLogger, toPinoLikeLogger } from "../logging.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import type { Provider } from "../utils.js";
import { CONFIG_DIR, ensureDir, jidToE164 } from "../utils.js";
import { VERSION } from "../version.js";

export const WA_WEB_AUTH_DIR = path.join(CONFIG_DIR, "credentials");
const WA_CREDS_PATH = path.join(WA_WEB_AUTH_DIR, "creds.json");
const WA_CREDS_BACKUP_PATH = path.join(WA_WEB_AUTH_DIR, "creds.json.bak");

function readCredsJsonRaw(filePath: string): string | null {
  try {
    if (!fsSync.existsSync(filePath)) return null;
    const stats = fsSync.statSync(filePath);
    if (!stats.isFile() || stats.size <= 1) return null;
    return fsSync.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function maybeRestoreCredsFromBackup(
  logger: ReturnType<typeof getChildLogger>,
): void {
  try {
    const raw = readCredsJsonRaw(WA_CREDS_PATH);
    if (raw) {
      // Validate that creds.json is parseable.
      JSON.parse(raw);
      return;
    }

    const backupRaw = readCredsJsonRaw(WA_CREDS_BACKUP_PATH);
    if (!backupRaw) return;

    // Ensure backup is parseable before restoring.
    JSON.parse(backupRaw);
    fsSync.copyFileSync(WA_CREDS_BACKUP_PATH, WA_CREDS_PATH);
    logger.warn(
      { credsPath: WA_CREDS_PATH },
      "restored corrupted WhatsApp creds.json from backup",
    );
  } catch {
    // ignore
  }
}

async function safeSaveCreds(
  saveCreds: () => Promise<void> | void,
  logger: ReturnType<typeof getChildLogger>,
): Promise<void> {
  try {
    // Best-effort backup so we can recover after abrupt restarts.
    if (fsSync.existsSync(WA_CREDS_PATH)) {
      fsSync.copyFileSync(WA_CREDS_PATH, WA_CREDS_BACKUP_PATH);
    }
  } catch {
    // ignore backup failures
  }
  try {
    await Promise.resolve(saveCreds());
  } catch (err) {
    logger.warn({ error: String(err) }, "failed saving WhatsApp creds");
  }
}

/**
 * Create a Baileys socket backed by the multi-file auth store we keep on disk.
 * Consumers can opt into QR printing for interactive login flows.
 */
export async function createWaSocket(printQr: boolean, verbose: boolean) {
  const baseLogger = getChildLogger(
    { module: "baileys" },
    {
      level: verbose ? "info" : "silent",
    },
  );
  const logger = toPinoLikeLogger(baseLogger, verbose ? "info" : "silent");
  await ensureDir(WA_WEB_AUTH_DIR);
  const sessionLogger = getChildLogger({ module: "web-session" });
  maybeRestoreCredsFromBackup(sessionLogger);
  const { state, saveCreds } = await useMultiFileAuthState(WA_WEB_AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    version,
    logger,
    printQRInTerminal: false,
    browser: ["clawdis", "cli", VERSION],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", () => safeSaveCreds(saveCreds, sessionLogger));
  sock.ev.on(
    "connection.update",
    (update: Partial<import("@whiskeysockets/baileys").ConnectionState>) => {
      try {
        const { connection, lastDisconnect, qr } = update;
        if (qr && printQr) {
          console.log("Scan this QR in WhatsApp (Linked Devices):");
          qrcode.generate(qr, { small: true });
        }
        if (connection === "close") {
          const status = getStatusCode(lastDisconnect?.error);
          if (status === DisconnectReason.loggedOut) {
            console.error(
              danger("WhatsApp session logged out. Run: clawdis login"),
            );
          }
        }
        if (connection === "open" && verbose) {
          console.log(success("WhatsApp Web connected."));
        }
      } catch (err) {
        sessionLogger.error(
          { error: String(err) },
          "connection.update handler error",
        );
      }
    },
  );

  // Handle WebSocket-level errors to prevent unhandled exceptions from crashing the process
  if (
    sock.ws &&
    typeof (sock.ws as unknown as { on?: unknown }).on === "function"
  ) {
    sock.ws.on("error", (err: Error) => {
      sessionLogger.error({ error: String(err) }, "WebSocket error");
    });
  }

  return sock;
}

export async function waitForWaConnection(
  sock: ReturnType<typeof makeWASocket>,
) {
  return new Promise<void>((resolve, reject) => {
    type OffCapable = {
      off?: (event: string, listener: (...args: unknown[]) => void) => void;
    };
    const evWithOff = sock.ev as unknown as OffCapable;

    const handler = (...args: unknown[]) => {
      const update = (args[0] ?? {}) as Partial<
        import("@whiskeysockets/baileys").ConnectionState
      >;
      if (update.connection === "open") {
        evWithOff.off?.("connection.update", handler);
        resolve();
      }
      if (update.connection === "close") {
        evWithOff.off?.("connection.update", handler);
        reject(update.lastDisconnect ?? new Error("Connection closed"));
      }
    };

    sock.ev.on("connection.update", handler);
  });
}

export function getStatusCode(err: unknown) {
  return (
    (err as { output?: { statusCode?: number } })?.output?.statusCode ??
    (err as { status?: number })?.status
  );
}

export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  const status = getStatusCode(err);
  const code = (err as { code?: unknown })?.code;
  if (status || code)
    return `status=${status ?? "unknown"} code=${code ?? "unknown"}`;
  return String(err);
}

export async function webAuthExists() {
  try {
    await fs.access(WA_WEB_AUTH_DIR);
  } catch {
    return false;
  }
  try {
    const stats = await fs.stat(WA_CREDS_PATH);
    if (!stats.isFile() || stats.size <= 1) return false;
    const raw = await fs.readFile(WA_CREDS_PATH, "utf-8");
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

export async function logoutWeb(runtime: RuntimeEnv = defaultRuntime) {
  const exists = await webAuthExists();
  if (!exists) {
    runtime.log(info("No WhatsApp Web session found; nothing to delete."));
    return false;
  }
  await fs.rm(WA_WEB_AUTH_DIR, { recursive: true, force: true });
  // Also drop session store to clear lingering per-sender state after logout.
  await fs.rm(resolveDefaultSessionStorePath(), { force: true });
  runtime.log(success("Cleared WhatsApp Web credentials."));
  return true;
}

export function readWebSelfId() {
  // Read the cached WhatsApp Web identity (jid + E.164) from disk if present.
  try {
    if (!fsSync.existsSync(WA_CREDS_PATH)) {
      return { e164: null, jid: null } as const;
    }
    const raw = fsSync.readFileSync(WA_CREDS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as { me?: { id?: string } } | undefined;
    const jid = parsed?.me?.id ?? null;
    const e164 = jid ? jidToE164(jid) : null;
    return { e164, jid } as const;
  } catch {
    return { e164: null, jid: null } as const;
  }
}

/**
 * Return the age (in milliseconds) of the cached WhatsApp web auth state, or null when missing.
 * Helpful for heartbeats/observability to spot stale credentials.
 */
export function getWebAuthAgeMs(): number | null {
  try {
    const stats = fsSync.statSync(WA_CREDS_PATH);
    return Date.now() - stats.mtimeMs;
  } catch {
    return null;
  }
}

export function newConnectionId() {
  return randomUUID();
}

export function logWebSelfId(
  runtime: RuntimeEnv = defaultRuntime,
  includeProviderPrefix = false,
) {
  // Human-friendly log of the currently linked personal web session.
  const { e164, jid } = readWebSelfId();
  const details =
    e164 || jid
      ? `${e164 ?? "unknown"}${jid ? ` (jid ${jid})` : ""}`
      : "unknown";
  const prefix = includeProviderPrefix ? "Web Provider: " : "";
  runtime.log(info(`${prefix}${details}`));
}

export async function pickProvider(pref: Provider | "auto"): Promise<Provider> {
  const choice: Provider = pref === "auto" ? "web" : pref;
  const hasWeb = await webAuthExists();
  if (!hasWeb) {
    throw new Error(
      "No WhatsApp Web session found. Run `clawdis login --verbose` to link.",
    );
  }
  return choice;
}
