import { EventEmitter } from "node:events";
import { vi } from "vitest";

type BaileysExports = typeof import("@whiskeysockets/baileys");
type FetchLatestBaileysVersionFn = BaileysExports["fetchLatestBaileysVersion"];
type MakeCacheableSignalKeyStoreFn = BaileysExports["makeCacheableSignalKeyStore"];
type MakeWASocketFn = BaileysExports["makeWASocket"];
type UseMultiFileAuthStateFn = BaileysExports["useMultiFileAuthState"];
type DownloadMediaMessageFn = BaileysExports["downloadMediaMessage"];

export type MockBaileysSocket = {
  ev: EventEmitter;
  ws: { close: ReturnType<typeof vi.fn> };
  sendPresenceUpdate: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  readMessages: ReturnType<typeof vi.fn>;
  user?: { id?: string };
};

export type MockBaileysModule = {
  DisconnectReason: { loggedOut: number };
  fetchLatestBaileysVersion: ReturnType<typeof vi.fn<FetchLatestBaileysVersionFn>>;
  makeCacheableSignalKeyStore: ReturnType<typeof vi.fn<MakeCacheableSignalKeyStoreFn>>;
  makeWASocket: ReturnType<typeof vi.fn<MakeWASocketFn>>;
  useMultiFileAuthState: ReturnType<typeof vi.fn<UseMultiFileAuthStateFn>>;
  jidToE164?: (jid: string) => string | null;
  proto?: unknown;
  downloadMediaMessage?: ReturnType<typeof vi.fn<DownloadMediaMessageFn>>;
};

export function createMockBaileys(): {
  mod: MockBaileysModule;
  lastSocket: () => MockBaileysSocket;
} {
  const sockets: MockBaileysSocket[] = [];
  const makeWASocket = vi.fn<MakeWASocketFn>((_opts) => {
    const ev = new EventEmitter();
    const sock: MockBaileysSocket = {
      ev,
      ws: { close: vi.fn() },
      sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue({ key: { id: "msg123" } }),
      readMessages: vi.fn().mockResolvedValue(undefined),
      user: { id: "123@s.whatsapp.net" },
    };
    setImmediate(() => ev.emit("connection.update", { connection: "open" }));
    sockets.push(sock);
    return sock as unknown as ReturnType<MakeWASocketFn>;
  });

  const mod: MockBaileysModule = {
    DisconnectReason: { loggedOut: 401 },
    fetchLatestBaileysVersion: vi
      .fn<FetchLatestBaileysVersionFn>()
      .mockResolvedValue({ version: [1, 2, 3], isLatest: true }),
    makeCacheableSignalKeyStore: vi.fn<MakeCacheableSignalKeyStoreFn>((keys) => keys),
    makeWASocket,
    useMultiFileAuthState: vi.fn<UseMultiFileAuthStateFn>(async () => ({
      state: { creds: {}, keys: {} } as Awaited<ReturnType<UseMultiFileAuthStateFn>>["state"],
      saveCreds: vi.fn(),
    })),
    jidToE164: (jid: string) => jid.replace(/@.*$/, "").replace(/^/, "+"),
    downloadMediaMessage: vi.fn<DownloadMediaMessageFn>().mockResolvedValue(Buffer.from("img")),
  };

  return {
    mod,
    lastSocket: () => {
      const last = sockets.at(-1);
      if (!last) {
        throw new Error("No Baileys sockets created");
      }
      return last;
    },
  };
}
