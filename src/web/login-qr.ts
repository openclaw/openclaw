import { DisconnectReason } from "@whiskeysockets/baileys";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config/config.js";
import { danger, info, success } from "../globals.js";
import { logInfo } from "../logger.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { resolveWhatsAppAccount } from "./accounts.js";
import { renderQrPngBase64 } from "./qr-image.js";
import {
  createWaSocket,
  formatError,
  getStatusCode,
  logoutWeb,
  readWebSelfId,
  waitForWaConnection,
  webAuthExists,
} from "./session.js";

type WaSocket = Awaited<ReturnType<typeof createWaSocket>>;

type LoginMethod = "qr" | "pairing";

type ActiveLogin = {
  accountId: string;
  authDir: string;
  isLegacyAuthDir: boolean;
  id: string;
  sock: WaSocket;
  startedAt: number;
  method: LoginMethod;
  qr?: string;
  qrDataUrl?: string;
  pairingCode?: string;
  connected: boolean;
  error?: string;
  errorStatus?: number;
  waitPromise: Promise<void>;
  restartAttempted: boolean;
  verbose: boolean;
};

const ACTIVE_LOGIN_TTL_MS = 3 * 60_000;
const activeLogins = new Map<string, ActiveLogin>();

function closeSocket(sock: WaSocket) {
  try {
    sock.ws?.close();
  } catch {
    // ignore
  }
}

async function resetActiveLogin(accountId: string, reason?: string) {
  const login = activeLogins.get(accountId);
  if (login) {
    closeSocket(login.sock);
    activeLogins.delete(accountId);
  }
  if (reason) {
    logInfo(reason);
  }
}

function isLoginFresh(login: ActiveLogin) {
  return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS;
}

function attachLoginWaiter(accountId: string, login: ActiveLogin) {
  login.waitPromise = waitForWaConnection(login.sock)
    .then(() => {
      const current = activeLogins.get(accountId);
      if (current?.id === login.id) {
        current.connected = true;
      }
    })
    .catch((err) => {
      const current = activeLogins.get(accountId);
      if (current?.id !== login.id) {
        return;
      }
      current.error = formatError(err);
      current.errorStatus = getStatusCode(err);
    });
}

async function restartLoginSocket(login: ActiveLogin, runtime: RuntimeEnv) {
  if (login.restartAttempted) {
    return false;
  }
  login.restartAttempted = true;
  runtime.log(
    info("WhatsApp asked for a restart after pairing (code 515); retrying connection once…"),
  );
  closeSocket(login.sock);
  try {
    const sock = await createWaSocket(false, login.verbose, {
      authDir: login.authDir,
    });
    login.sock = sock;
    login.connected = false;
    login.error = undefined;
    login.errorStatus = undefined;
    attachLoginWaiter(login.accountId, login);
    return true;
  } catch (err) {
    login.error = formatError(err);
    login.errorStatus = getStatusCode(err);
    return false;
  }
}

export async function startWebLoginWithQr(
  opts: {
    verbose?: boolean;
    timeoutMs?: number;
    force?: boolean;
    accountId?: string;
    runtime?: RuntimeEnv;
  } = {},
): Promise<{ qrDataUrl?: string; message: string }> {
  const runtime = opts.runtime ?? defaultRuntime;
  const cfg = loadConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId: opts.accountId });
  const hasWeb = await webAuthExists(account.authDir);
  const selfId = readWebSelfId(account.authDir);
  if (hasWeb && !opts.force) {
    const who = selfId.e164 ?? selfId.jid ?? "unknown";
    return {
      message: `WhatsApp is already linked (${who}). Say “relink” if you want a fresh QR.`,
    };
  }

  const existing = activeLogins.get(account.accountId);
  if (existing && isLoginFresh(existing) && existing.qrDataUrl) {
    return {
      qrDataUrl: existing.qrDataUrl,
      message: "QR already active. Scan it in WhatsApp → Linked Devices.",
    };
  }

  await resetActiveLogin(account.accountId);

  let resolveQr: ((qr: string) => void) | null = null;
  let rejectQr: ((err: Error) => void) | null = null;
  const qrPromise = new Promise<string>((resolve, reject) => {
    resolveQr = resolve;
    rejectQr = reject;
  });

  const qrTimer = setTimeout(
    () => {
      rejectQr?.(new Error("Timed out waiting for WhatsApp QR"));
    },
    Math.max(opts.timeoutMs ?? 30_000, 5000),
  );

  let sock: WaSocket;
  let pendingQr: string | null = null;
  try {
    sock = await createWaSocket(false, Boolean(opts.verbose), {
      authDir: account.authDir,
      onQr: (qr: string) => {
        if (pendingQr) {
          return;
        }
        pendingQr = qr;
        const current = activeLogins.get(account.accountId);
        if (current && !current.qr) {
          current.qr = qr;
        }
        clearTimeout(qrTimer);
        runtime.log(info("WhatsApp QR received."));
        resolveQr?.(qr);
      },
    });
  } catch (err) {
    clearTimeout(qrTimer);
    await resetActiveLogin(account.accountId);
    return {
      message: `Failed to start WhatsApp login: ${String(err)}`,
    };
  }
  const login: ActiveLogin = {
    accountId: account.accountId,
    authDir: account.authDir,
    isLegacyAuthDir: account.isLegacyAuthDir,
    id: randomUUID(),
    sock,
    startedAt: Date.now(),
    method: "qr",
    connected: false,
    waitPromise: Promise.resolve(),
    restartAttempted: false,
    verbose: Boolean(opts.verbose),
  };
  activeLogins.set(account.accountId, login);
  if (pendingQr && !login.qr) {
    login.qr = pendingQr;
  }
  attachLoginWaiter(account.accountId, login);

  let qr: string;
  try {
    qr = await qrPromise;
  } catch (err) {
    clearTimeout(qrTimer);
    await resetActiveLogin(account.accountId);
    return {
      message: `Failed to get QR: ${String(err)}`,
    };
  }

  const base64 = await renderQrPngBase64(qr);
  login.qrDataUrl = `data:image/png;base64,${base64}`;
  return {
    qrDataUrl: login.qrDataUrl,
    message: "Scan this QR in WhatsApp → Linked Devices.",
  };
}

export async function startWebLoginWithPairingCode(opts: {
  phoneNumber: string;
  verbose?: boolean;
  timeoutMs?: number;
  force?: boolean;
  accountId?: string;
  runtime?: RuntimeEnv;
}): Promise<{ pairingCode?: string; message: string }> {
  const runtime = opts.runtime ?? defaultRuntime;
  const cfg = loadConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId: opts.accountId });
  const hasWeb = await webAuthExists(account.authDir);
  const selfId = readWebSelfId(account.authDir);
  if (hasWeb && !opts.force) {
    const who = selfId.e164 ?? selfId.jid ?? "unknown";
    return {
      message: `WhatsApp is already linked (${who}). Use force=true to relink.`,
    };
  }

  const phoneNumber = opts.phoneNumber.replace(/[^0-9]/g, "");
  if (phoneNumber.length < 10 || phoneNumber.length > 15) {
    return {
      message: "Invalid phone number. Use international format without + (e.g., 14155551234).",
    };
  }

  await resetActiveLogin(account.accountId);

  let sock: WaSocket;
  try {
    sock = await createWaSocket(false, Boolean(opts.verbose), {
      authDir: account.authDir,
    });
  } catch (err) {
    await resetActiveLogin(account.accountId);
    return {
      message: `Failed to start WhatsApp login: ${String(err)}`,
    };
  }

  const login: ActiveLogin = {
    accountId: account.accountId,
    authDir: account.authDir,
    isLegacyAuthDir: account.isLegacyAuthDir,
    id: randomUUID(),
    sock,
    startedAt: Date.now(),
    method: "pairing",
    connected: false,
    waitPromise: Promise.resolve(),
    restartAttempted: false,
    verbose: Boolean(opts.verbose),
  };
  activeLogins.set(account.accountId, login);
  attachLoginWaiter(account.accountId, login);

  try {
    if (typeof sock.requestPairingCode !== "function") {
      await resetActiveLogin(account.accountId);
      return {
        message: "Pairing code authentication is not supported by this Baileys version.",
      };
    }

    const timeoutMs = opts.timeoutMs ?? 30_000;
    const pairingCodePromise = sock.requestPairingCode(phoneNumber);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error("Timed out waiting for pairing code")),
        timeoutMs,
      );
    });

    const pairingCode = await Promise.race([pairingCodePromise, timeoutPromise]).finally(() => {
      clearTimeout(timeoutId);
    });
    login.pairingCode = pairingCode;
    runtime.log(info(`WhatsApp pairing code received: ${pairingCode}`));
    return {
      pairingCode,
      message: `Enter this code in WhatsApp → Linked Devices → Link with phone number: ${pairingCode}`,
    };
  } catch (err) {
    await resetActiveLogin(account.accountId);
    return {
      message: `Failed to get pairing code: ${String(err)}`,
    };
  }
}

export async function waitForWebLogin(
  opts: { timeoutMs?: number; runtime?: RuntimeEnv; accountId?: string } = {},
): Promise<{ connected: boolean; message: string }> {
  const runtime = opts.runtime ?? defaultRuntime;
  const cfg = loadConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId: opts.accountId });
  const activeLogin = activeLogins.get(account.accountId);
  if (!activeLogin) {
    return {
      connected: false,
      message: "No active WhatsApp login in progress.",
    };
  }

  const login = activeLogin;
  const isPairingCode = login.method === "pairing";
  const expiredMessage = isPairingCode
    ? "The pairing code session expired. Request a new pairing code."
    : "The login QR expired. Ask me to generate a new one.";
  const waitingMessage = isPairingCode
    ? "Still waiting for the pairing code to be entered. Let me know when done."
    : "Still waiting for the QR scan. Let me know when you've scanned it.";
  const loggedOutMessage = isPairingCode
    ? "WhatsApp reported the session is logged out. Cleared cached web session; please request a new pairing code."
    : "WhatsApp reported the session is logged out. Cleared cached web session; please scan a new QR.";

  if (!isLoginFresh(login)) {
    await resetActiveLogin(account.accountId);
    return {
      connected: false,
      message: expiredMessage,
    };
  }
  const timeoutMs = Math.max(opts.timeoutMs ?? 120_000, 1000);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        connected: false,
        message: waitingMessage,
      };
    }
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timeoutId = setTimeout(() => resolve("timeout"), remaining);
    });
    const result = await Promise.race([login.waitPromise.then(() => "done" as const), timeout]);
    clearTimeout(timeoutId);

    if (result === "timeout") {
      return {
        connected: false,
        message: waitingMessage,
      };
    }

    // Yield to microtask queue so attachLoginWaiter's .then() can set
    // login.connected before we check it (avoids transient false-negative).
    await Promise.resolve();

    if (login.error) {
      if (login.errorStatus === DisconnectReason.loggedOut) {
        await logoutWeb({
          authDir: login.authDir,
          isLegacyAuthDir: login.isLegacyAuthDir,
          runtime,
        });
        await resetActiveLogin(account.accountId, loggedOutMessage);
        runtime.log(danger(loggedOutMessage));
        return { connected: false, message: loggedOutMessage };
      }
      if (login.errorStatus === 515) {
        const restarted = await restartLoginSocket(login, runtime);
        if (restarted && isLoginFresh(login)) {
          continue;
        }
      }
      const message = `WhatsApp login failed: ${login.error}`;
      await resetActiveLogin(account.accountId, message);
      runtime.log(danger(message));
      return { connected: false, message };
    }

    if (login.connected) {
      const message = "✅ Linked! WhatsApp is ready.";
      runtime.log(success(message));
      await resetActiveLogin(account.accountId);
      return { connected: true, message };
    }

    // waitPromise resolved but connected/error not yet set — retry the loop
    // instead of returning a false-negative.
    if (isLoginFresh(login)) {
      continue;
    }

    return { connected: false, message: "Login ended without a connection." };
  }
}
