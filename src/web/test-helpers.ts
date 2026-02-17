import { vi } from "vitest";
import type { MockBaileysSocket } from "../../test/mocks/baileys.js";
import { createMockBaileys } from "../../test/mocks/baileys.js";
import { clearConfigCache } from "../config/io.js";

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
  if (process.env.OPENCLAW_DEBUG_WEB_CFG === "1") {
    // eslint-disable-next-line no-console
    console.log("DEBUG_SET_LOAD_CONFIG", JSON.stringify(fn, null, 2));
  }
  (globalThis as Record<symbol, unknown>)[CONFIG_KEY] = typeof fn === "function" ? fn : () => fn;
  clearConfigCache();
}

export function resetLoadConfigMock() {
  (globalThis as Record<symbol, unknown>)[CONFIG_KEY] = () => DEFAULT_CONFIG;
  clearConfigCache();
}

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => {
      const getter = (globalThis as Record<symbol, unknown>)[CONFIG_KEY];
      if (process.env.OPENCLAW_DEBUG_WEB_CFG === "1") {
        // eslint-disable-next-line no-console
        console.log("DEBUG_MOCK_LOAD_CONFIG", typeof getter);
      }
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
      if (process.env.OPENCLAW_DEBUG_WEB_CFG === "1") {
        // eslint-disable-next-line no-console
        console.log("DEBUG_MOCK_LOAD_CONFIG_ALT", typeof getter);
      }
      if (typeof getter === "function") {
        return getter();
      }
      return DEFAULT_CONFIG;
    },
  };
});

// Some auto-reply monitor modules are nested one level deeper and import config via
// `../../../config/config.js`; mock that specifier too so group-gating tests can
// reliably override config per test case.
vi.mock("../../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => {
      const getter = (globalThis as Record<symbol, unknown>)[CONFIG_KEY];
      if (process.env.OPENCLAW_DEBUG_WEB_CFG === "1") {
        // eslint-disable-next-line no-console
        console.log("DEBUG_MOCK_LOAD_CONFIG_DEEP", typeof getter);
      }
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
  // @ts-expect-error
  baileys.makeWASocket = vi.fn(recreated.mod.makeWASocket);
  // @ts-expect-error
  baileys.useMultiFileAuthState = vi.fn(recreated.mod.useMultiFileAuthState);
  // @ts-expect-error
  baileys.fetchLatestBaileysVersion = vi.fn(recreated.mod.fetchLatestBaileysVersion);
  // @ts-expect-error
  baileys.makeCacheableSignalKeyStore = vi.fn(recreated.mod.makeCacheableSignalKeyStore);
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
