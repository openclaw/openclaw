import path from "node:path";
import os from "node:os";
import {
	DisconnectReason,
	fetchLatestBaileysVersion,
	makeCacheableSignalKeyStore,
	makeWASocket,
	useMultiFileAuthState,
} from "baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { danger, info, logVerbose, success } from "./globals.js";
import { ensureDir, toWhatsappJid } from "./utils.js";

const WA_WEB_AUTH_DIR = path.join(os.homedir(), ".warelay", "waweb");

export async function createWaSocket(printQr: boolean, verbose: boolean) {
	await ensureDir(WA_WEB_AUTH_DIR);
	const { state, saveCreds } = await useMultiFileAuthState(WA_WEB_AUTH_DIR);
	const { version } = await fetchLatestBaileysVersion();
	const logger = pino({ level: verbose ? "info" : "silent" });
	const sock = makeWASocket({
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		version,
		printQRInTerminal: false,
		browser: ["Warelay", "CLI", "1.0.0"],
		syncFullHistory: false,
		markOnlineOnConnect: false,
	});

	sock.ev.on("creds.update", saveCreds);
	sock.ev.on("connection.update", (update: Partial<import("baileys").ConnectionState>) => {
		const { connection, lastDisconnect, qr } = update;
		if (qr && printQr) {
			console.log("Scan this QR in WhatsApp (Linked Devices):");
			qrcode.generate(qr, { small: true });
		}
		if (connection === "close") {
			const code = (lastDisconnect?.error as { output?: { statusCode?: number } })
				?.output?.statusCode;
			if (code === DisconnectReason.loggedOut) {
				console.error(
					danger("WhatsApp session logged out. Run: warelay web:login"),
				);
			}
		}
		if (connection === "open" && verbose) {
			console.log(success("WhatsApp Web connected."));
		}
	});

	return sock;
}

export async function waitForWaConnection(sock: ReturnType<typeof makeWASocket>) {
	return new Promise<void>((resolve, reject) => {
		type OffCapable = {
			off?: (event: string, listener: (...args: unknown[]) => void) => void;
		};
		const evWithOff = sock.ev as unknown as OffCapable;

		const handler = (...args: unknown[]) => {
			const update = (args[0] ?? {}) as Partial<import("baileys").ConnectionState>;
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

export async function sendMessageWeb(
	to: string,
	body: string,
	options: { verbose: boolean },
) {
	const sock = await createWaSocket(false, options.verbose);
	try {
		await waitForWaConnection(sock);
		const jid = toWhatsappJid(to);
		try {
			await sock.sendPresenceUpdate("composing", jid);
		} catch (err) {
			logVerbose(`Presence update skipped: ${String(err)}`);
		}
		const result = await sock.sendMessage(jid, { text: body });
		const messageId = result?.key?.id ?? "unknown";
		console.log(success(`✅ Sent via web session. Message ID: ${messageId} -> ${jid}`));
	} finally {
		try {
			sock.ws?.close();
		} catch (err) {
			logVerbose(`Socket close failed: ${String(err)}`);
		}
	}
}

export async function loginWeb(verbose: boolean) {
	const sock = await createWaSocket(true, verbose);
	console.log(info("Waiting for WhatsApp connection..."));
	try {
		await waitForWaConnection(sock);
		console.log(success("✅ Linked! Credentials saved for future sends."));
	} finally {
		setTimeout(() => {
			try {
				sock.ws?.close();
			} catch {
				// ignore
			}
		}, 500);
	}
}

export { WA_WEB_AUTH_DIR };
