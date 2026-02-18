import { vi } from "vitest";
import type { MockBaileysSocket } from "../../test/mocks/baileys.js";
import { createMockBaileys } from "../../test/mocks/baileys.js";

// Use globalThis to store the mock config so it survives vi.mock hoisting
const CONFIG_KEY = Symbol.for("openclaw:testConfigMock");
const DEFAULT_CONFIG = {
  channels: {
    whatsapp: {
      // Tests can override; default remains open to avoid surprising fixtures
      allowFrom: ["*"],
    },
  },
  messages: {
    messagePrefix: undefined,
    responsePrefix: undefined,
  },
};

// Initialize default if not set
if (!(globalThis as Record<symbol, unknown>)[CONFIG_KEY]) {
  (globalThis as Record<symbol, unknown>)[CONFIG_KEY] = () => DEFAULT_CONFIG;
}

export function setLoadConfigMock(fn: unknown) {
  (globalThis as Record<symbol, unknown>)[CONFIG_KEY] = typeof fn === "function" ? fn : () => fn;
}

export function resetLoadConfigMock() {
  (globalThis as Record<symbol, unknown>)[CONFIG_KEY] = () => DEFAULT_CONFIG;
}

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => {
      const getter = (globalThis as Record<symbol, unknown>)[CONFIG_KEY];
      if (typeof getter === "function") {
        return getter();
      }
      return DEFAULT_CONFIG;
    },
  };
});

// Some web modules live under `src/web/auto-reply/*` and import config via a different
// relative path (`../../config/config.js`). Mock both specifiers so tests stay stable
// across refactors that move files between folders.
vi.mock("../../config/config.js", async (importOriginal) => {
  // `../../config/config.js` is correct for modules under `src/web/auto-reply/*`.
  // For typing in this file (which lives in `src/web/*`), refer to the same module
  // via the local relative path.
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => {
      const getter = (globalThis as Record<symbol, unknown>)[CONFIG_KEY];
      if (typeof getter === "function") {
        return getter();
      }
      return DEFAULT_CONFIG;
    },
  };
});

vi.mock("../media/store.js", () => ({
  saveMediaBuffer: vi.fn().mockImplementation(async (_buf: Buffer, contentType?: string) => ({
    id: "mid",
    path: "/tmp/mid",
    size: _buf.length,
    contentType,
  })),
}));

vi.mock("@whiskeysockets/baileys", () => {
  const created = createMockBaileys();
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw:lastSocket")] =
    created.lastSocket;
  return created.mod;
});

vi.mock("qrcode-terminal", () => ({
  default: { generate: vi.fn() },
  generate: vi.fn(),
}));

export const baileys = await import("@whiskeysockets/baileys");

export function resetBaileysMocks() {
  const recreated = createMockBaileys();
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw:lastSocket")] =
    recreated.lastSocket;

  const makeWASocket = vi.mocked(baileys.makeWASocket);
  const makeWASocketImpl: typeof baileys.makeWASocket = (...args) =>
    (recreated.mod.makeWASocket as unknown as typeof baileys.makeWASocket)(...args);
  makeWASocket.mockReset();
  makeWASocket.mockImplementation(makeWASocketImpl);

  const useMultiFileAuthState = vi.mocked(baileys.useMultiFileAuthState);
  const useMultiFileAuthStateImpl: typeof baileys.useMultiFileAuthState = (...args) =>
    (recreated.mod.useMultiFileAuthState as unknown as typeof baileys.useMultiFileAuthState)(
      ...args,
    );
  useMultiFileAuthState.mockReset();
  useMultiFileAuthState.mockImplementation(useMultiFileAuthStateImpl);

  const fetchLatestBaileysVersion = vi.mocked(baileys.fetchLatestBaileysVersion);
  const fetchLatestBaileysVersionImpl: typeof baileys.fetchLatestBaileysVersion = (...args) =>
    (
      recreated.mod.fetchLatestBaileysVersion as unknown as typeof baileys.fetchLatestBaileysVersion
    )(...args);
  fetchLatestBaileysVersion.mockReset();
  fetchLatestBaileysVersion.mockImplementation(fetchLatestBaileysVersionImpl);

  const makeCacheableSignalKeyStore = vi.mocked(baileys.makeCacheableSignalKeyStore);
  const makeCacheableSignalKeyStoreImpl: typeof baileys.makeCacheableSignalKeyStore = (...args) =>
    (
      recreated.mod
        .makeCacheableSignalKeyStore as unknown as typeof baileys.makeCacheableSignalKeyStore
    )(...args);
  makeCacheableSignalKeyStore.mockReset();
  makeCacheableSignalKeyStore.mockImplementation(makeCacheableSignalKeyStoreImpl);
}

export function getLastSocket(): MockBaileysSocket {
  const getter = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw:lastSocket")];
  if (typeof getter === "function") {
    return (getter as () => MockBaileysSocket)();
  }
  if (!getter) {
    throw new Error("Baileys mock not initialized");
  }
  throw new Error("Invalid Baileys socket getter");
}
