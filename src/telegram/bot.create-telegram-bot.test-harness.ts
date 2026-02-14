import { beforeEach, vi, type Mock } from "vitest";
import { resetInboundDedupe } from "../auto-reply/reply/inbound-dedupe.js";

type AnyMock = Mock<(...args: unknown[]) => unknown>;
type AnyAsyncMock = Mock<(...args: unknown[]) => Promise<unknown>>;
type ReplyOpts =
  | {
      onReplyStart?: () => void | Promise<void>;
    }
  | undefined;

const { sessionStorePath } = vi.hoisted(() => ({
  sessionStorePath: `/tmp/openclaw-telegram-${Math.random().toString(16).slice(2)}.json`,
}));

const { loadWebMedia } = vi.hoisted((): { loadWebMedia: AnyMock } => ({
  loadWebMedia: vi.fn(),
}));

export function getLoadWebMediaMock(): AnyMock {
  return loadWebMedia;
}

vi.mock("../web/media.js", () => ({
  loadWebMedia,
}));

const { loadConfig } = vi.hoisted((): { loadConfig: AnyMock } => ({
  loadConfig: vi.fn(() => ({})),
}));

export function getLoadConfigMock(): AnyMock {
  return loadConfig;
}
vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig,
  };
});

vi.mock("../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions.js")>();
  return {
    ...actual,
    resolveStorePath: vi.fn((storePath) => storePath ?? sessionStorePath),
  };
});

const { readChannelAllowFromStore, upsertChannelPairingRequest } = vi.hoisted(
  (): {
    readChannelAllowFromStore: AnyAsyncMock;
    upsertChannelPairingRequest: AnyAsyncMock;
  } => ({
    readChannelAllowFromStore: vi.fn(async () => [] as string[]),
    upsertChannelPairingRequest: vi.fn(async () => ({
      code: "PAIRCODE",
      created: true,
    })),
  }),
);

export function getReadChannelAllowFromStoreMock(): AnyAsyncMock {
  return readChannelAllowFromStore;
}

export function getUpsertChannelPairingRequestMock(): AnyAsyncMock {
  return upsertChannelPairingRequest;
}

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
}));

export const useSpy: Mock<(arg: unknown) => void> = vi.fn();
export const middlewareUseSpy: Mock<(...args: unknown[]) => unknown> = vi.fn();
export const onSpy: Mock<(...args: unknown[]) => unknown> = vi.fn();
export const stopSpy: Mock<(...args: unknown[]) => unknown> = vi.fn();
export const commandSpy: Mock<(...args: unknown[]) => unknown> = vi.fn();
export const botCtorSpy: Mock<(...args: unknown[]) => unknown> = vi.fn();
export const answerCallbackQuerySpy: AnyAsyncMock = vi.fn(async () => undefined);
export const sendChatActionSpy: AnyMock = vi.fn();
export const setMessageReactionSpy: AnyAsyncMock = vi.fn(async () => undefined);
export const setMyCommandsSpy: AnyAsyncMock = vi.fn(async () => undefined);
export const deleteMyCommandsSpy: AnyAsyncMock = vi.fn(async () => undefined);
export const getMeSpy: AnyAsyncMock = vi.fn(async () => ({
  username: "openclaw_bot",
  has_topics_enabled: true,
}));
export const sendMessageSpy: AnyAsyncMock = vi.fn(async () => ({ message_id: 77 }));
export const sendAnimationSpy: AnyAsyncMock = vi.fn(async () => ({ message_id: 78 }));
export const sendPhotoSpy: AnyAsyncMock = vi.fn(async () => ({ message_id: 79 }));

type ApiStub = {
  config: { use: (arg: unknown) => void };
  answerCallbackQuery: typeof answerCallbackQuerySpy;
  sendChatAction: typeof sendChatActionSpy;
  setMessageReaction: typeof setMessageReactionSpy;
  setMyCommands: typeof setMyCommandsSpy;
  deleteMyCommands: typeof deleteMyCommandsSpy;
  getMe: typeof getMeSpy;
  sendMessage: typeof sendMessageSpy;
  sendAnimation: typeof sendAnimationSpy;
  sendPhoto: typeof sendPhotoSpy;
};

const apiStub: ApiStub = {
  config: { use: useSpy },
  answerCallbackQuery: answerCallbackQuerySpy,
  sendChatAction: sendChatActionSpy,
  setMessageReaction: setMessageReactionSpy,
  setMyCommands: setMyCommandsSpy,
  deleteMyCommands: deleteMyCommandsSpy,
  getMe: getMeSpy,
  sendMessage: sendMessageSpy,
  sendAnimation: sendAnimationSpy,
  sendPhoto: sendPhotoSpy,
};

vi.mock("grammy", () => ({
  Bot: class {
    api = apiStub;
    use = middlewareUseSpy;
    on = onSpy;
    stop = stopSpy;
    command = commandSpy;
    catch = vi.fn();
    constructor(
      public token: string,
      public options?: { client?: { fetch?: typeof fetch } },
    ) {
      botCtorSpy(token, options);
    }
  },
  InputFile: class {},
  webhookCallback: vi.fn(),
}));

const sequentializeMiddleware = vi.fn();
export const sequentializeSpy: AnyMock = vi.fn(() => sequentializeMiddleware);
export let sequentializeKey: ((ctx: unknown) => string) | undefined;
vi.mock("@grammyjs/runner", () => ({
  sequentialize: (keyFn: (ctx: unknown) => string) => {
    sequentializeKey = keyFn;
    return sequentializeSpy();
  },
}));

export const throttlerSpy: AnyMock = vi.fn(() => "throttler");

vi.mock("@grammyjs/transformer-throttler", () => ({
  apiThrottler: () => throttlerSpy(),
}));

export const replySpy: Mock<(ctx: unknown, opts?: ReplyOpts) => Promise<void>> = vi.fn(
  async (_ctx, opts) => {
    await opts?.onReplyStart?.();
    return undefined;
  },
);

vi.mock("../auto-reply/reply.js", () => ({
  getReplyFromConfig: replySpy,
  __replySpy: replySpy,
}));

export const getOnHandler = (event: string) => {
  const handler = onSpy.mock.calls.find((call) => call[0] === event)?.[1];
  if (!handler) {
    throw new Error(`Missing handler for event: ${event}`);
  }
  return handler as (ctx: Record<string, unknown>) => Promise<void>;
};

beforeEach(() => {
  resetInboundDedupe();
  loadConfig.mockReturnValue({
    channels: {
      telegram: { dmPolicy: "open", allowFrom: ["*"] },
    },
  });
  loadWebMedia.mockReset();
  onSpy.mockReset();
  commandSpy.mockReset();
  stopSpy.mockReset();
  useSpy.mockReset();

  sendAnimationSpy.mockReset();
  sendAnimationSpy.mockResolvedValue({ message_id: 78 });
  sendPhotoSpy.mockReset();
  sendPhotoSpy.mockResolvedValue({ message_id: 79 });
  sendMessageSpy.mockReset();
  sendMessageSpy.mockResolvedValue({ message_id: 77 });

  setMessageReactionSpy.mockReset();
  setMessageReactionSpy.mockResolvedValue(undefined);
  answerCallbackQuerySpy.mockReset();
  answerCallbackQuerySpy.mockResolvedValue(undefined);
  sendChatActionSpy.mockReset();
  sendChatActionSpy.mockResolvedValue(undefined);
  setMyCommandsSpy.mockReset();
  setMyCommandsSpy.mockResolvedValue(undefined);
  deleteMyCommandsSpy.mockReset();
  deleteMyCommandsSpy.mockResolvedValue(undefined);
  getMeSpy.mockReset();
  getMeSpy.mockResolvedValue({
    username: "openclaw_bot",
    has_topics_enabled: true,
  });
  middlewareUseSpy.mockReset();
  sequentializeSpy.mockReset();
  botCtorSpy.mockReset();
  sequentializeKey = undefined;
});
