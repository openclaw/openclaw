import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";
import { resetLogger, setLoggerOverride } from "../logging.js";

export const DEFAULT_ACCOUNT_ID = "default";

export const DEFAULT_WEB_INBOX_CONFIG = {
  channels: {
    whatsapp: {
      // Allow all in tests by default.
      allowFrom: ["*"],
    },
  },
  messages: {
    messagePrefix: undefined,
    responsePrefix: undefined,
  },
} as const;

export const mockLoadConfig: MockFn<() => typeof DEFAULT_WEB_INBOX_CONFIG> = vi
  .fn()
  .mockReturnValue(DEFAULT_WEB_INBOX_CONFIG);

export const readAllowFromStoreMock: MockFn<(...args: unknown[]) => Promise<unknown[]>> = vi
  .fn()
  .mockResolvedValue([]);
export const upsertPairingRequestMock: MockFn<
  (...args: unknown[]) => Promise<{ code: string; created: boolean }>
> = vi.fn().mockResolvedValue({ code: "PAIRCODE", created: true });

export type MockSock = {
  ev: EventEmitter;
  ws: { close: MockFn };
  sendPresenceUpdate: MockFn;
  sendMessage: MockFn;
  readMessages: MockFn;
  updateMediaMessage: MockFn;
  logger: Record<string, unknown>;
  signalRepository: {
    lidMapping: {
      getPNForLID: MockFn;
    };
  };
  user: { id: string };
};

function createMockSock(): MockSock {
  const ev = new EventEmitter();
  return {
    ev,
    ws: { close: vi.fn() },
    sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    readMessages: vi.fn().mockResolvedValue(undefined),
    updateMediaMessage: vi.fn(),
    logger: {},
    signalRepository: {
      lidMapping: {
        getPNForLID: vi.fn().mockResolvedValue(null),
      },
    },
    user: { id: "123@s.whatsapp.net" },
  };
}

const sock: MockSock = createMockSock();

vi.mock("../media/store.js", () => ({
  saveMediaBuffer: vi.fn().mockResolvedValue({
    id: "mid",
    path: "/tmp/mid",
    size: 1,
    contentType: "image/jpeg",
  }),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => mockLoadConfig(),
  };
});

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: (...args: unknown[]) => readAllowFromStoreMock(...args),
  upsertChannelPairingRequest: (...args: unknown[]) => upsertPairingRequestMock(...args),
}));

vi.mock("./session.js", () => ({
  createWaSocket: vi.fn().mockResolvedValue(sock),
  waitForWaConnection: vi.fn().mockResolvedValue(undefined),
  getStatusCode: vi.fn(() => 500),
}));

export function getSock(): MockSock {
  return sock;
}

let authDir: string | undefined;

export function getAuthDir(): string {
  if (!authDir) {
    throw new Error("authDir not initialized; call installWebMonitorInboxUnitTestHooks()");
  }
  return authDir;
}

export function installWebMonitorInboxUnitTestHooks(opts?: { authDir?: boolean }) {
  const createAuthDir = opts?.authDir ?? true;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(DEFAULT_WEB_INBOX_CONFIG);
    readAllowFromStoreMock.mockResolvedValue([]);
    upsertPairingRequestMock.mockResolvedValue({
      code: "PAIRCODE",
      created: true,
    });
    const { resetWebInboundDedupe } = await import("./inbound.js");
    resetWebInboundDedupe();
    if (createAuthDir) {
      authDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-"));
    } else {
      authDir = undefined;
    }
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    vi.useRealTimers();
    if (authDir) {
      fsSync.rmSync(authDir, { recursive: true, force: true });
      authDir = undefined;
    }
  });
}
