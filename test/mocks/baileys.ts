import { EventEmitter } from "node:events";

import { vi } from "vitest";

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
  fetchLatestBaileysVersion: ReturnType<typeof vi.fn>;
  makeCacheableSignalKeyStore: ReturnType<typeof vi.fn>;
  makeWASocket: ReturnType<typeof vi.fn>;
  useMultiFileAuthState: ReturnType<typeof vi.fn>;
  jidToE164?: (jid: string) => string | null;
  proto?: unknown;
  downloadMediaMessage?: ReturnType<typeof vi.fn>;
};

export function createMockBaileys(): {
  mod: MockBaileysModule;
  lastSocket: () => MockBaileysSocket;
} {
  const sockets: MockBaileysSocket[] = [];
  const makeWASocket = vi.fn((_opts: unknown) => {
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
    return sock;
  });

  const mod: MockBaileysModule = {
    DisconnectReason: { loggedOut: 401 },
    fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [1, 2, 3] }),
    makeCacheableSignalKeyStore: vi.fn((keys: unknown) => keys),
    makeWASocket,
    useMultiFileAuthState: vi.fn(async () => ({
      state: { creds: {}, keys: {} },
      saveCreds: vi.fn(),
    })),
    jidToE164: (jid: string) => jid.replace(/@.*$/, "").replace(/^/, "+"),
    downloadMediaMessage: vi.fn().mockResolvedValue(Buffer.from("img")),
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
