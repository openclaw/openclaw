import { beforeEach, vi, type Mock } from "vitest";
import { resetInboundDedupe } from "../auto-reply/reply/inbound-dedupe.js";

export const useSpy: Mock = vi.fn();
export const middlewareUseSpy: Mock = vi.fn();
export const onSpy: Mock = vi.fn();
export const stopSpy: Mock = vi.fn();
export const sendChatActionSpy: Mock = vi.fn();

type ApiStub = {
  config: { use: (arg: unknown) => void };
  sendChatAction: Mock;
  sendMessage: Mock;
  setMyCommands: (commands: Array<{ command: string; description: string }>) => Promise<void>;
};

const apiStub: ApiStub = {
  config: { use: useSpy },
  sendChatAction: sendChatActionSpy,
  sendMessage: vi.fn(async () => ({ message_id: 1 })),
  setMyCommands: vi.fn(async () => undefined),
};

beforeEach(() => {
  resetInboundDedupe();
});

vi.mock("grammy", () => ({
  Bot: class {
    api = apiStub;
    use = middlewareUseSpy;
    on = onSpy;
    command = vi.fn();
    stop = stopSpy;
    catch = vi.fn();
    constructor(public token: string) {}
  },
  InputFile: class {},
  webhookCallback: vi.fn(),
}));

vi.mock("@grammyjs/runner", () => ({
  sequentialize: () => vi.fn(),
}));

const throttlerSpy = vi.fn(() => "throttler");
vi.mock("@grammyjs/transformer-throttler", () => ({
  apiThrottler: () => throttlerSpy(),
}));

vi.mock("../media/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media/store.js")>();
  return {
    ...actual,
    saveMediaBuffer: vi.fn(async (buffer: Buffer, contentType?: string) => ({
      id: "media",
      path: "/tmp/telegram-media",
      size: buffer.byteLength,
      contentType: contentType ?? "application/octet-stream",
    })),
  };
});

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    }),
  };
});

vi.mock("../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions.js")>();
  return {
    ...actual,
    updateLastRoute: vi.fn(async () => undefined),
  };
});

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn(async () => [] as string[]),
  upsertChannelPairingRequest: vi.fn(async () => ({
    code: "PAIRCODE",
    created: true,
  })),
}));

vi.mock("../auto-reply/reply.js", () => {
  const replySpy = vi.fn(async (_ctx, opts) => {
    await opts?.onReplyStart?.();
    return undefined;
  });
  return { getReplyFromConfig: replySpy, __replySpy: replySpy };
});
