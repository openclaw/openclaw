import { DisconnectReason } from "@whiskeysockets/baileys";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import { formatCliCommand } from "../cli/command-format.js";
import { loadConfig } from "../config/config.js";
import { danger, info, success } from "../globals.js";
import { logInfo } from "../logger.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { resolveWhatsAppAccount } from "./accounts.js";
import { createWaSocket, formatError, logoutWeb, waitForWaConnection } from "./session.js";

/** Timeout for waiting for socket initialization before requesting pairing code. */
const PAIRING_CODE_INIT_TIMEOUT_MS = 10_000;

export type LoginWebOptions = {
  /** Use pairing code instead of QR. */
  useCode?: boolean;
  /** Phone number for pairing code (E.164 format, e.g. +1234567890). */
  phoneNumber?: string;
};

/**
 * Normalize a phone number to digits only (with optional leading +).
 * Handles common formats: +1-234-567-890, (123) 456-7890, +1 234 567 890
 */
export function normalizePhoneNumber(phone: string): string {
  return phone.trim().replace(/[^\d+]/g, "");
}

async function promptPhoneNumber(_runtime: RuntimeEnv): Promise<string> {
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question("Enter your phone number (E.164 format, e.g. +1234567890): ");
  rl.close();
  return normalizePhoneNumber(answer);
}

export async function loginWeb(
  verbose: boolean,
  waitForConnection?: typeof waitForWaConnection,
  runtime: RuntimeEnv = defaultRuntime,
  accountId?: string,
  opts: LoginWebOptions = {},
) {
  const wait = waitForConnection ?? waitForWaConnection;
  const cfg = loadConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId });
  const useCode = opts.useCode === true;

  // When using pairing code, don't print QR
  const sock = await createWaSocket(!useCode, verbose, {
    authDir: account.authDir,
  });

  // If using pairing code, request it after socket is ready
  if (useCode) {
    let phoneNumber = opts.phoneNumber ? normalizePhoneNumber(opts.phoneNumber) : "";
    if (!phoneNumber) {
      phoneNumber = await promptPhoneNumber(runtime);
    }
    if (!phoneNumber) {
      throw new Error("Phone number is required for pairing code login");
    }
    // Remove + prefix if present, Baileys expects just digits
    const normalizedPhone = phoneNumber.replace(/^\+/, "");
    logInfo(`Requesting pairing code for ${phoneNumber}...`, runtime);

    // Wait for socket to initialize before requesting pairing code.
    // Baileys needs to complete the WebSocket handshake before requestPairingCode works.
    // We wait for the first connection.update event which indicates the socket is ready.
    await sock.waitForConnectionUpdate(
      async () => true, // Accept first update (socket initialized)
      PAIRING_CODE_INIT_TIMEOUT_MS,
    );

    try {
      const code = await sock.requestPairingCode(normalizedPhone);
      console.log(success(`\n📱 Pairing code: ${code}\n`));
      console.log(info("Enter this code in WhatsApp:"));
      console.log(info("  1. Open WhatsApp on your phone"));
      console.log(info("  2. Go to Settings → Linked Devices"));
      console.log(info("  3. Tap 'Link a Device'"));
      console.log(info("  4. Tap 'Link with phone number instead'"));
      console.log(info(`  5. Enter the code: ${code}\n`));
    } catch (err) {
      throw new Error(`Failed to request pairing code: ${formatError(err)}`, { cause: err });
    }
  } else {
    logInfo("Scan the QR code in WhatsApp (Linked Devices)...", runtime);
  }

  logInfo("Waiting for WhatsApp connection...", runtime);
  try {
    await wait(sock);
    console.log(success("✅ Linked! Credentials saved for future sends."));
  } catch (err) {
    const code =
      (err as { error?: { output?: { statusCode?: number } } })?.error?.output?.statusCode ??
      (err as { output?: { statusCode?: number } })?.output?.statusCode;
    if (code === 515) {
      console.log(
        info(
          "WhatsApp asked for a restart after pairing (code 515); creds are saved. Restarting connection once…",
        ),
      );
      try {
        sock.ws?.close();
      } catch {
        // ignore
      }
      const retry = await createWaSocket(false, verbose, {
        authDir: account.authDir,
      });
      try {
        await wait(retry);
        console.log(success("✅ Linked after restart; web session ready."));
        return;
      } finally {
        setTimeout(() => retry.ws?.close(), 500);
      }
    }
    if (code === DisconnectReason.loggedOut) {
      await logoutWeb({
        authDir: account.authDir,
        isLegacyAuthDir: account.isLegacyAuthDir,
        runtime,
      });
      console.error(
        danger(
          `WhatsApp reported the session is logged out. Cleared cached web session; please rerun ${formatCliCommand("openclaw channels login")} and scan the QR again.`,
        ),
      );
      throw new Error("Session logged out; cache cleared. Re-run login.", { cause: err });
    }
    const formatted = formatError(err);
    console.error(danger(`WhatsApp Web connection ended before fully opening. ${formatted}`));
    throw new Error(formatted, { cause: err });
  } finally {
    // Let Baileys flush any final events before closing the socket.
    setTimeout(() => {
      try {
        sock.ws?.close();
      } catch {
        // ignore
      }
    }, 500);
  }
}
