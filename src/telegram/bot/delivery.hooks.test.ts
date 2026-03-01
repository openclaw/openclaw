import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "grammy";
import { deliverReplies } from "./delivery.js";

// --- mock hook runner ---
const getGlobalHookRunnerMock = vi.fn();

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => getGlobalHookRunnerMock(),
}));

// --- other mocks required by delivery.ts ---
vi.mock("../../web/media.js", () => ({
  loadWebMedia: vi.fn(),
}));

vi.mock("grammy", () => ({
  InputFile: class {
    constructor(
      public buffer: Buffer,
      public fileName?: string,
    ) {}
  },
  GrammyError: class GrammyError extends Error {
    description = "";
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CHAT_ID = "99999";
const TEXT = "Hello, hook world!";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function createRuntime() {
  return { error: vi.fn(), log: vi.fn() };
}

function createBot(api: Record<string, unknown> = {}): Bot {
  return { api } as unknown as Bot;
}

type FakeRunner = {
  hasHooks: ReturnType<typeof vi.fn>;
  runMessageSending: ReturnType<typeof vi.fn>;
  runMessageSent: ReturnType<typeof vi.fn>;
};

function createFakeRunner(opts: {
  hasHooksFn?: (name: string) => boolean;
  sendingResult?: { cancel?: boolean } | null;
  sendingError?: Error;
}): FakeRunner {
  return {
    hasHooks: vi.fn((name: string) => opts.hasHooksFn?.(name) ?? true),
    runMessageSending: vi.fn(() =>
      opts.sendingError
        ? Promise.reject(opts.sendingError)
        : Promise.resolve(opts.sendingResult ?? undefined),
    ),
    runMessageSent: vi.fn(() => Promise.resolve(undefined)),
  };
}

async function deliver(bot: Bot, runner: FakeRunner | null, text = TEXT) {
  getGlobalHookRunnerMock.mockReturnValue(runner);
  return deliverReplies({
    replies: [{ text }],
    chatId: CHAT_ID,
    token: "tok",
    runtime: createRuntime(),
    bot,
    replyToMode: "off",
    textLimit: 4000,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deliverReplies – message_sending / message_sent hooks", () => {
  beforeEach(() => {
    getGlobalHookRunnerMock.mockReset();
  });

  it("fires message_sending with correct payload and channel context before send", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 1, chat: { id: CHAT_ID } });
    const bot = createBot({ sendMessage });
    const runner = createFakeRunner({});

    await deliver(bot, runner);

    expect(runner.runMessageSending).toHaveBeenCalledWith(
      { to: CHAT_ID, content: TEXT, metadata: { channel: "telegram" } },
      { channelId: "telegram" },
    );
    // send happened after hook
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does NOT call sendMessage or message_sent when message_sending returns { cancel: true }", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 1, chat: { id: CHAT_ID } });
    const bot = createBot({ sendMessage });
    const runner = createFakeRunner({ sendingResult: { cancel: true } });

    await deliver(bot, runner);
    await flush();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(runner.runMessageSent).not.toHaveBeenCalled();
  });

  it("fires message_sent with { to, content, success: true } after successful send", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 1, chat: { id: CHAT_ID } });
    const bot = createBot({ sendMessage });
    const runner = createFakeRunner({});

    await deliver(bot, runner);
    await flush();

    expect(runner.runMessageSent).toHaveBeenCalledWith(
      { to: CHAT_ID, content: TEXT, success: true },
      { channelId: "telegram" },
    );
  });

  it("proceeds normally (send is called) when message_sending hook is absent", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 1, chat: { id: CHAT_ID } });
    const bot = createBot({ sendMessage });
    const runner = createFakeRunner({ hasHooksFn: () => false });

    await deliver(bot, runner);

    expect(runner.runMessageSending).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does NOT block delivery when message_sending hook throws", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 1, chat: { id: CHAT_ID } });
    const bot = createBot({ sendMessage });
    const runner = createFakeRunner({ sendingError: new Error("hook kaboom") });

    await expect(deliver(bot, runner)).resolves.toBeDefined();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("fires message_sent with success: false and error when sendMessage throws", async () => {
    const errorMsg = "telegram send failure";
    const sendMessage = vi.fn().mockRejectedValue(new Error(errorMsg));
    const bot = createBot({ sendMessage });
    const runner = createFakeRunner({});

    await expect(deliver(bot, runner)).rejects.toThrow();
    await flush();

    expect(runner.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({ to: CHAT_ID, success: false, error: errorMsg }),
      { channelId: "telegram" },
    );
  });
});
