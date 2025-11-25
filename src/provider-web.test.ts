import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockBaileysSocket } from "../test/mocks/baileys.js";
import { createMockBaileys } from "../test/mocks/baileys.js";

vi.mock("@whiskeysockets/baileys", () => {
	const created = createMockBaileys();
	(globalThis as Record<PropertyKey, unknown>)[
		Symbol.for("warelay:lastSocket")
	] = created.lastSocket;
	return created.mod;
});

vi.mock("./media/store.js", () => ({
	saveMediaBuffer: vi
		.fn()
		.mockImplementation(async (_buf: Buffer, contentType?: string) => ({
			id: "mid",
			path: "/tmp/mid",
			size: _buf.length,
			contentType,
		})),
}));

let loadConfigMock: () => unknown = () => ({});
vi.mock("./config/config.js", () => ({
	loadConfig: () => loadConfigMock(),
}));

function getLastSocket(): MockBaileysSocket {
	const getter = (globalThis as Record<PropertyKey, unknown>)[
		Symbol.for("warelay:lastSocket")
	];
	if (typeof getter === "function")
		return (getter as () => MockBaileysSocket)();
	if (!getter) throw new Error("Baileys mock not initialized");
	throw new Error("Invalid Baileys socket getter");
}

vi.mock("qrcode-terminal", () => ({
	default: { generate: vi.fn() },
	generate: vi.fn(),
}));

import { monitorWebProvider } from "./index.js";
import { resetLogger, setLoggerOverride } from "./logging.js";
import {
	createWaSocket,
	loginWeb,
	logWebSelfId,
	monitorWebInbox,
	sendMessageWeb,
	waitForWaConnection,
} from "./provider-web.js";

const baileys = (await import(
	"@whiskeysockets/baileys"
)) as unknown as typeof import("@whiskeysockets/baileys") & {
	makeWASocket: ReturnType<typeof vi.fn>;
	useMultiFileAuthState: ReturnType<typeof vi.fn>;
	fetchLatestBaileysVersion: ReturnType<typeof vi.fn>;
	makeCacheableSignalKeyStore: ReturnType<typeof vi.fn>;
};

describe("provider-web", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		loadConfigMock = () => ({});
		const recreated = createMockBaileys();
		(globalThis as Record<PropertyKey, unknown>)[
			Symbol.for("warelay:lastSocket")
		] = recreated.lastSocket;
		baileys.makeWASocket.mockImplementation(recreated.mod.makeWASocket);
		baileys.useMultiFileAuthState.mockImplementation(
			recreated.mod.useMultiFileAuthState,
		);
		baileys.fetchLatestBaileysVersion.mockImplementation(
			recreated.mod.fetchLatestBaileysVersion,
		);
		baileys.makeCacheableSignalKeyStore.mockImplementation(
			recreated.mod.makeCacheableSignalKeyStore,
		);
	});

	afterEach(() => {
		vi.useRealTimers();
		resetLogger();
		setLoggerOverride(null);
	});

	it("creates WA socket with QR handler", async () => {
		await createWaSocket(true, false);
		const makeWASocket = baileys.makeWASocket as ReturnType<typeof vi.fn>;
		expect(makeWASocket).toHaveBeenCalledWith(
			expect.objectContaining({ printQRInTerminal: false }),
		);
		const passed = makeWASocket.mock.calls[0][0];
		const passedLogger = (
			passed as { logger?: { level?: string; trace?: unknown } }
		).logger;
		expect(passedLogger?.level).toBe("silent");
		expect(typeof passedLogger?.trace).toBe("function");
		const sock = getLastSocket();
		const saveCreds = (
			await baileys.useMultiFileAuthState.mock.results[0].value
		).saveCreds;
		// trigger creds.update listener
		sock.ev.emit("creds.update", {});
		expect(saveCreds).toHaveBeenCalled();
	});

	it("waits for connection open", async () => {
		const ev = new EventEmitter();
		const promise = waitForWaConnection({ ev } as unknown as ReturnType<
			typeof baileys.makeWASocket
		>);
		ev.emit("connection.update", { connection: "open" });
		await expect(promise).resolves.toBeUndefined();
	});

	it("rejects when connection closes", async () => {
		const ev = new EventEmitter();
		const promise = waitForWaConnection({ ev } as unknown as ReturnType<
			typeof baileys.makeWASocket
		>);
		ev.emit("connection.update", {
			connection: "close",
			lastDisconnect: new Error("bye"),
		});
		await expect(promise).rejects.toBeInstanceOf(Error);
	});

	it("sends message via web and closes socket", async () => {
		await sendMessageWeb("+1555", "hi", { verbose: false });
		const sock = getLastSocket();
		expect(sock.sendMessage).toHaveBeenCalled();
		expect(sock.ws.close).toHaveBeenCalled();
	});

	it("loginWeb waits for connection and closes", async () => {
		const closeSpy = vi.fn();
		const ev = new EventEmitter();
		baileys.makeWASocket.mockImplementation(() => ({
			ev,
			ws: { close: closeSpy },
			sendPresenceUpdate: vi.fn(),
			sendMessage: vi.fn(),
		}));
		const waiter: typeof waitForWaConnection = vi
			.fn()
			.mockResolvedValue(undefined);
		await loginWeb(false, waiter);
		await new Promise((resolve) => setTimeout(resolve, 550));
		expect(closeSpy).toHaveBeenCalled();
	});

	it("monitorWebInbox streams inbound messages", async () => {
		const onMessage = vi.fn(async (msg) => {
			await msg.sendComposing();
			await msg.reply("pong");
		});

		const listener = await monitorWebInbox({ verbose: false, onMessage });
		const sock = getLastSocket();
		expect(sock.sendPresenceUpdate).toHaveBeenCalledWith("available");
		const upsert = {
			type: "notify",
			messages: [
				{
					key: { id: "abc", fromMe: false, remoteJid: "[redacted-email]" },
					message: { conversation: "ping" },
					messageTimestamp: 1_700_000_000,
					pushName: "Tester",
				},
			],
		};

		sock.ev.emit("messages.upsert", upsert);
		await new Promise((resolve) => setImmediate(resolve));

		expect(onMessage).toHaveBeenCalledWith(
			expect.objectContaining({ body: "ping", from: "+999", to: "+123" }),
		);
		expect(sock.readMessages).toHaveBeenCalledWith([
			{
				remoteJid: "[redacted-email]",
				id: "abc",
				participant: undefined,
				fromMe: false,
			},
		]);
		expect(sock.sendPresenceUpdate).toHaveBeenCalledWith("available");
		expect(sock.sendPresenceUpdate).toHaveBeenCalledWith(
			"composing",
			"[redacted-email]",
		);
		expect(sock.sendMessage).toHaveBeenCalledWith("[redacted-email]", {
			text: "pong",
		});

		await listener.close();
	});

	it("monitorWebInbox captures media path for image messages", async () => {
		const onMessage = vi.fn();
		const listener = await monitorWebInbox({ verbose: false, onMessage });
		const sock = getLastSocket();
		const upsert = {
			type: "notify",
			messages: [
				{
					key: { id: "med1", fromMe: false, remoteJid: "[redacted-email]" },
					message: { imageMessage: { mimetype: "image/jpeg" } },
					messageTimestamp: 1_700_000_100,
				},
			],
		};

		sock.ev.emit("messages.upsert", upsert);
		await new Promise((resolve) => setImmediate(resolve));

		expect(onMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				body: "<media:image>",
				mediaPath: "/tmp/mid",
				mediaType: "image/jpeg",
			}),
		);
		expect(sock.readMessages).toHaveBeenCalledWith([
			{
				remoteJid: "[redacted-email]",
				id: "med1",
				participant: undefined,
				fromMe: false,
			},
		]);
		expect(sock.sendPresenceUpdate).toHaveBeenCalledWith("available");
		await listener.close();
	});

	it("monitorWebInbox resolves onClose when the socket closes", async () => {
		const listener = await monitorWebInbox({
			verbose: false,
			onMessage: vi.fn(),
		});
		const sock = getLastSocket();
		const reasonPromise = listener.onClose;
		sock.ev.emit("connection.update", {
			connection: "close",
			lastDisconnect: { error: { output: { statusCode: 500 } } },
		});
		await expect(reasonPromise).resolves.toEqual(
			expect.objectContaining({ status: 500, isLoggedOut: false }),
		);
		await listener.close();
	});

	it("monitorWebInbox logs inbound bodies to file", async () => {
		const logPath = path.join(
			os.tmpdir(),
			`warelay-log-test-${crypto.randomUUID()}.log`,
		);
		setLoggerOverride({ level: "trace", file: logPath });

		const onMessage = vi.fn();
		const listener = await monitorWebInbox({ verbose: false, onMessage });
		const sock = getLastSocket();
		const upsert = {
			type: "notify",
			messages: [
				{
					key: { id: "abc", fromMe: false, remoteJid: "[redacted-email]" },
					message: { conversation: "ping" },
					messageTimestamp: 1_700_000_000,
					pushName: "Tester",
				},
			],
		};

		sock.ev.emit("messages.upsert", upsert);
		await new Promise((resolve) => setImmediate(resolve));

		const content = fsSync.readFileSync(logPath, "utf-8");
		expect(content).toContain('"module":"web-inbound"');
		expect(content).toContain('"body":"ping"');
		await listener.close();
	});

	it("monitorWebInbox includes participant when marking group messages read", async () => {
		const onMessage = vi.fn();
		const listener = await monitorWebInbox({ verbose: false, onMessage });
		const sock = getLastSocket();
		const upsert = {
			type: "notify",
			messages: [
				{
					key: {
						id: "grp1",
						fromMe: false,
						remoteJid: "[redacted-email]",
						participant: "[redacted-email]",
					},
					message: { conversation: "group ping" },
				},
			],
		};

		sock.ev.emit("messages.upsert", upsert);
		await new Promise((resolve) => setImmediate(resolve));

		expect(sock.readMessages).toHaveBeenCalledWith([
			{
				remoteJid: "[redacted-email]",
				id: "grp1",
				participant: "[redacted-email]",
				fromMe: false,
			},
		]);
		await listener.close();
	});

	it("monitorWebProvider reconnects after a connection close", async () => {
		vi.useFakeTimers();
		const closeResolvers: Array<() => void> = [];
		const listenerFactory = vi.fn(async () => {
			let _resolve!: () => void;
			const onClose = new Promise<void>((res) => {
				_resolve = res;
				closeResolvers.push(res);
			});
			return { close: vi.fn(), onClose };
		});
		const runtime = {
			log: vi.fn(),
			error: vi.fn(),
			exit: vi.fn(),
		};
		const controller = new AbortController();
		const run = monitorWebProvider(
			false,
			listenerFactory,
			true,
			async () => ({ text: "ok" }),
			runtime as never,
			controller.signal,
		);

		await Promise.resolve();
		expect(listenerFactory).toHaveBeenCalledTimes(1);

		closeResolvers[0]?.();
		await Promise.resolve();
		await vi.runOnlyPendingTimersAsync();
		expect(listenerFactory).toHaveBeenCalledTimes(2);
		expect(runtime.error).toHaveBeenCalledWith(
			expect.stringContaining("Reconnecting"),
		);

		controller.abort();
		closeResolvers[1]?.();
		await vi.runAllTimersAsync();
		await run;
	});

	it("monitorWebProvider falls back to text when media send fails", async () => {
		const sendMedia = vi.fn().mockRejectedValue(new Error("boom"));
		const reply = vi.fn().mockResolvedValue(undefined);
		const sendComposing = vi.fn();
		const resolver = vi.fn().mockResolvedValue({
			text: "hi",
			mediaUrl: "https://example.com/img.png",
		});

		let capturedOnMessage:
			| ((msg: import("./provider-web.js").WebInboundMessage) => Promise<void>)
			| undefined;
		const listenerFactory = async (opts: {
			onMessage: (
				msg: import("./provider-web.js").WebInboundMessage,
			) => Promise<void>;
		}) => {
			capturedOnMessage = opts.onMessage;
			return { close: vi.fn() };
		};

		const smallPng = await sharp({
			create: {
				width: 200,
				height: 200,
				channels: 3,
				background: { r: 0, g: 255, b: 0 },
			},
		})
			.png()
			.toBuffer();
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			body: true,
			arrayBuffer: async () =>
				smallPng.buffer.slice(
					smallPng.byteOffset,
					smallPng.byteOffset + smallPng.byteLength,
				),
			headers: { get: () => "image/png" },
			status: 200,
		} as Response);

		await monitorWebProvider(false, listenerFactory, false, resolver);

		expect(capturedOnMessage).toBeDefined();
		await capturedOnMessage?.({
			body: "hello",
			from: "+1",
			to: "+2",
			id: "msg1",
			sendComposing,
			reply,
			sendMedia,
		});

		expect(sendMedia).toHaveBeenCalled();
		expect(reply).toHaveBeenCalledWith("hi");
		fetchMock.mockRestore();
	});

	it("compresses media over 5MB and still sends it", async () => {
		const sendMedia = vi.fn();
		const reply = vi.fn().mockResolvedValue(undefined);
		const sendComposing = vi.fn();
		const resolver = vi.fn().mockResolvedValue({
			text: "hi",
			mediaUrl: "https://example.com/big.png",
		});

		let capturedOnMessage:
			| ((msg: import("./provider-web.js").WebInboundMessage) => Promise<void>)
			| undefined;
		const listenerFactory = async (opts: {
			onMessage: (
				msg: import("./provider-web.js").WebInboundMessage,
			) => Promise<void>;
		}) => {
			capturedOnMessage = opts.onMessage;
			return { close: vi.fn() };
		};

		// Create a large ( >5MB ) PNG to trigger compression.
		const bigPng = await sharp({
			create: {
				width: 3200,
				height: 3200,
				channels: 3,
				background: { r: 255, g: 0, b: 0 },
			},
		})
			.png({ compressionLevel: 0 })
			.toBuffer();
		expect(bigPng.length).toBeGreaterThan(5 * 1024 * 1024);

		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			body: true,
			arrayBuffer: async () =>
				bigPng.buffer.slice(
					bigPng.byteOffset,
					bigPng.byteOffset + bigPng.byteLength,
				),
			headers: { get: () => "image/png" },
			status: 200,
		} as Response);

		await monitorWebProvider(false, listenerFactory, false, resolver);
		expect(capturedOnMessage).toBeDefined();

		await capturedOnMessage?.({
			body: "hello",
			from: "+1",
			to: "+2",
			id: "msg1",
			sendComposing,
			reply,
			sendMedia,
		});

		expect(sendMedia).toHaveBeenCalledTimes(1);
		const payload = sendMedia.mock.calls[0][0] as {
			image: Buffer;
			caption?: string;
			mimetype?: string;
		};
		expect(payload.image.length).toBeLessThanOrEqual(5 * 1024 * 1024);
		expect(payload.mimetype).toBe("image/jpeg");
		// Should not fall back to separate text reply because caption is used.
		expect(reply).not.toHaveBeenCalled();

		fetchMock.mockRestore();
	});

	it(
		"compresses common formats to jpeg under the cap",
		{ timeout: 15_000 },
		async () => {
		const formats = [
			{
				name: "png",
				mime: "image/png",
				make: (buf: Buffer, opts: { width: number; height: number }) =>
					sharp(buf, {
						raw: { width: opts.width, height: opts.height, channels: 3 },
					})
						.png({ compressionLevel: 0 })
						.toBuffer(),
			},
			{
				name: "jpeg",
				mime: "image/jpeg",
				make: (buf: Buffer, opts: { width: number; height: number }) =>
					sharp(buf, {
						raw: { width: opts.width, height: opts.height, channels: 3 },
					})
						.jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
						.toBuffer(),
			},
			{
				name: "webp",
				mime: "image/webp",
				make: (buf: Buffer, opts: { width: number; height: number }) =>
					sharp(buf, {
						raw: { width: opts.width, height: opts.height, channels: 3 },
					})
						.webp({ quality: 100 })
						.toBuffer(),
			},
		] as const;

		for (const fmt of formats) {
			// Force a small cap to ensure compression is exercised for every format.
			loadConfigMock = () => ({ inbound: { reply: { mediaMaxMb: 1 } } });
			const sendMedia = vi.fn();
			const reply = vi.fn().mockResolvedValue(undefined);
			const sendComposing = vi.fn();
			const resolver = vi.fn().mockResolvedValue({
				text: "hi",
				mediaUrl: `https://example.com/big.${fmt.name}`,
			});

			let capturedOnMessage:
				| ((
						msg: import("./provider-web.js").WebInboundMessage,
				  ) => Promise<void>)
				| undefined;
			const listenerFactory = async (opts: {
				onMessage: (
					msg: import("./provider-web.js").WebInboundMessage,
				) => Promise<void>;
			}) => {
				capturedOnMessage = opts.onMessage;
				return { close: vi.fn() };
			};

			const width = 2000;
			const height = 2000;
			const raw = crypto.randomBytes(width * height * 3);
			const big = await fmt.make(raw, { width, height });
			expect(big.length).toBeGreaterThan(1 * 1024 * 1024);

			const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
				ok: true,
				body: true,
				arrayBuffer: async () =>
					big.buffer.slice(big.byteOffset, big.byteOffset + big.byteLength),
				headers: { get: () => fmt.mime },
				status: 200,
			} as Response);

			await monitorWebProvider(false, listenerFactory, false, resolver);
			expect(capturedOnMessage).toBeDefined();

			await capturedOnMessage?.({
				body: "hello",
				from: "+1",
				to: "+2",
				id: `msg-${fmt.name}`,
				sendComposing,
				reply,
				sendMedia,
			});

			expect(sendMedia).toHaveBeenCalledTimes(1);
			const payload = sendMedia.mock.calls[0][0] as {
				image: Buffer;
				mimetype?: string;
			};
			expect(payload.image.length).toBeLessThanOrEqual(1 * 1024 * 1024);
			expect(payload.mimetype).toBe("image/jpeg");
			expect(reply).not.toHaveBeenCalled();

			fetchMock.mockRestore();
		}
	});

	it("honors mediaMaxMb from config", async () => {
		loadConfigMock = () => ({ inbound: { reply: { mediaMaxMb: 1 } } });
		const sendMedia = vi.fn();
		const reply = vi.fn().mockResolvedValue(undefined);
		const sendComposing = vi.fn();
		const resolver = vi.fn().mockResolvedValue({
			text: "hi",
			mediaUrl: "https://example.com/big.png",
		});

		let capturedOnMessage:
			| ((msg: import("./provider-web.js").WebInboundMessage) => Promise<void>)
			| undefined;
		const listenerFactory = async (opts: {
			onMessage: (
				msg: import("./provider-web.js").WebInboundMessage,
			) => Promise<void>;
		}) => {
			capturedOnMessage = opts.onMessage;
			return { close: vi.fn() };
		};

		const bigPng = await sharp({
			create: {
				width: 2600,
				height: 2600,
				channels: 3,
				background: { r: 0, g: 0, b: 255 },
			},
		})
			.png({ compressionLevel: 0 })
			.toBuffer();
		expect(bigPng.length).toBeGreaterThan(1 * 1024 * 1024);

		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			body: true,
			arrayBuffer: async () =>
				bigPng.buffer.slice(
					bigPng.byteOffset,
					bigPng.byteOffset + bigPng.byteLength,
				),
			headers: { get: () => "image/png" },
			status: 200,
		} as Response);

		await monitorWebProvider(false, listenerFactory, false, resolver);
		expect(capturedOnMessage).toBeDefined();

		await capturedOnMessage?.({
			body: "hello",
			from: "+1",
			to: "+2",
			id: "msg1",
			sendComposing,
			reply,
			sendMedia,
		});

		expect(sendMedia).toHaveBeenCalledTimes(1);
		const payload = sendMedia.mock.calls[0][0] as {
			image: Buffer;
			caption?: string;
			mimetype?: string;
		};
		expect(payload.image.length).toBeLessThanOrEqual(1 * 1024 * 1024);
		expect(payload.mimetype).toBe("image/jpeg");
		expect(reply).not.toHaveBeenCalled();

		fetchMock.mockRestore();
	});

	it("falls back to text when media is unsupported", async () => {
		const sendMedia = vi.fn();
		const reply = vi.fn().mockResolvedValue(undefined);
		const sendComposing = vi.fn();
		const resolver = vi.fn().mockResolvedValue({
			text: "hi",
			mediaUrl: "https://example.com/file.pdf",
		});

		let capturedOnMessage:
			| ((msg: import("./provider-web.js").WebInboundMessage) => Promise<void>)
			| undefined;
		const listenerFactory = async (opts: {
			onMessage: (
				msg: import("./provider-web.js").WebInboundMessage,
			) => Promise<void>;
		}) => {
			capturedOnMessage = opts.onMessage;
			return { close: vi.fn() };
		};

		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			body: true,
			arrayBuffer: async () => Buffer.from("%PDF-1.4").buffer,
			headers: { get: () => "application/pdf" },
			status: 200,
		} as Response);

		await monitorWebProvider(false, listenerFactory, false, resolver);
		expect(capturedOnMessage).toBeDefined();

		await capturedOnMessage?.({
			body: "hello",
			from: "+1",
			to: "+2",
			id: "msg-pdf",
			sendComposing,
			reply,
			sendMedia,
		});

		expect(sendMedia).not.toHaveBeenCalled();
		expect(reply).toHaveBeenCalledWith("hi");

		fetchMock.mockRestore();
	});

	it("logs outbound replies to file", async () => {
		const logPath = path.join(
			os.tmpdir(),
			`warelay-log-test-${crypto.randomUUID()}.log`,
		);
		setLoggerOverride({ level: "trace", file: logPath });

		let capturedOnMessage:
			| ((msg: import("./provider-web.js").WebInboundMessage) => Promise<void>)
			| undefined;
		const listenerFactory = async (opts: {
			onMessage: (
				msg: import("./provider-web.js").WebInboundMessage,
			) => Promise<void>;
		}) => {
			capturedOnMessage = opts.onMessage;
			return { close: vi.fn() };
		};

		const resolver = vi.fn().mockResolvedValue({ text: "auto" });
		await monitorWebProvider(false, listenerFactory, false, resolver);
		expect(capturedOnMessage).toBeDefined();

		await capturedOnMessage?.({
			body: "hello",
			from: "+1",
			to: "+2",
			id: "msg1",
			sendComposing: vi.fn(),
			reply: vi.fn(),
			sendMedia: vi.fn(),
		});

		const content = fsSync.readFileSync(logPath, "utf-8");
		expect(content).toContain('"module":"web-auto-reply"');
		expect(content).toContain('"text":"auto"');
	});

	it("logWebSelfId prints cached E.164 when creds exist", () => {
		const existsSpy = vi
			.spyOn(fsSync, "existsSync")
			.mockReturnValue(true as never);
		const readSpy = vi
			.spyOn(fsSync, "readFileSync")
			.mockReturnValue(JSON.stringify({ me: { id: "[redacted-email]" } }));
		const runtime = {
			log: vi.fn(),
			error: vi.fn(),
			exit: vi.fn(),
		};

		logWebSelfId(runtime as never, true);

		expect(runtime.log).toHaveBeenCalledWith(
			"Web Provider: +12345 (jid [redacted-email])",
		);
		existsSpy.mockRestore();
		readSpy.mockRestore();
	});
});
