import { beforeEach, vi } from "vitest";

type NotificationHandler = (msg: { method: string; params?: unknown }) => void;

// Avoid exporting vitest mock types (TS2742 under pnpm + d.ts emit).
// oxlint-disable-next-line typescript/no-explicit-any
type AnyMock = any;

const state = vi.hoisted(() => ({
  requestMock: vi.fn(),
  stopMock: vi.fn(),
  sendMock: vi.fn(),
  replyMock: vi.fn(),
  updateLastRouteMock: vi.fn(),
  readAllowFromStoreMock: vi.fn(),
  upsertPairingRequestMock: vi.fn(),
  config: {} as Record<string, unknown>,
  notificationHandler: undefined as NotificationHandler | undefined,
  closeResolve: undefined as (() => void) | undefined,
}));

export function getRequestMock(): AnyMock {
  return state.requestMock;
}

export function getStopMock(): AnyMock {
  return state.stopMock;
}

export function getSendMock(): AnyMock {
  return state.sendMock;
}

export function getReplyMock(): AnyMock {
  return state.replyMock;
}

export function getUpdateLastRouteMock(): AnyMock {
  return state.updateLastRouteMock;
}

export function getReadAllowFromStoreMock(): AnyMock {
  return state.readAllowFromStoreMock;
}

export function getUpsertPairingRequestMock(): AnyMock {
  return state.upsertPairingRequestMock;
}

export function getNotificationHandler(): NotificationHandler | undefined {
  return state.notificationHandler;
}

export function getCloseResolve(): (() => void) | undefined {
  return state.closeResolve;
}

export function setConfigMock(next: Record<string, unknown>) {
  state.config = next;
}

export function getConfigMock() {
  return state.config;
}

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => state.config,
  };
});

vi.mock("../auto-reply/reply.js", () => ({
  getReplyFromConfig: (...args: unknown[]) => state.replyMock(...args),
}));

vi.mock("./send.js", () => ({
  sendMessageIMessage: (...args: unknown[]) => state.sendMock(...args),
}));

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: (...args: unknown[]) => state.readAllowFromStoreMock(...args),
  upsertChannelPairingRequest: (...args: unknown[]) => state.upsertPairingRequestMock(...args),
}));

vi.mock("../config/sessions.js", () => ({
  resolveStorePath: vi.fn(() => "/tmp/openclaw-sessions.json"),
  updateLastRoute: (...args: unknown[]) => state.updateLastRouteMock(...args),
  readSessionUpdatedAt: vi.fn(() => undefined),
  recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./client.js", () => ({
  createIMessageRpcClient: vi.fn(async (opts: { onNotification?: NotificationHandler }) => {
    state.notificationHandler = opts.onNotification;
    return {
      request: (...args: unknown[]) => state.requestMock(...args),
      waitForClose: () =>
        new Promise<void>((resolve) => {
          state.closeResolve = resolve;
        }),
      stop: (...args: unknown[]) => state.stopMock(...args),
    };
  }),
}));

vi.mock("./probe.js", () => ({
  probeIMessage: vi.fn(async () => ({ ok: true })),
}));

export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

export async function waitForSubscribe() {
  for (let i = 0; i < 25; i += 1) {
    if (state.requestMock.mock.calls.some((call) => call[0] === "watch.subscribe")) {
      return;
    }
    // Prefer microtask turns over timers for speed.
    await Promise.resolve();
  }
  for (let i = 0; i < 5; i += 1) {
    if (state.requestMock.mock.calls.some((call) => call[0] === "watch.subscribe")) {
      return;
    }
    await flush();
  }
  throw new Error("imessage test harness: watch.subscribe not observed");
}

export function installMonitorIMessageProviderTestHooks() {
  beforeEach(() => {
    state.config = {
      channels: {
        imessage: {
          dmPolicy: "open",
          allowFrom: ["*"],
          groups: { "*": { requireMention: true } },
        },
      },
      session: { mainKey: "main" },
      messages: {
        groupChat: { mentionPatterns: ["@openclaw"] },
      },
    };
    state.requestMock.mockReset().mockImplementation((method: string) => {
      if (method === "watch.subscribe") {
        return Promise.resolve({ subscription: 1 });
      }
      return Promise.resolve({});
    });
    state.stopMock.mockReset().mockResolvedValue(undefined);
    state.sendMock.mockReset().mockResolvedValue({ messageId: "ok" });
    state.replyMock.mockReset().mockResolvedValue({ text: "ok" });
    state.updateLastRouteMock.mockReset();
    state.readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    state.upsertPairingRequestMock
      .mockReset()
      .mockResolvedValue({ code: "PAIRCODE", created: true });
    state.notificationHandler = undefined;
    state.closeResolve = undefined;
  });
}
