import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetInboundDedupe } from "../auto-reply/reply/inbound-dedupe.js";
import { createTelegramBot } from "./bot.js";

const { sessionStorePath } = vi.hoisted(() => ({
  sessionStorePath: `/tmp/openclaw-telegram-${Math.random().toString(16).slice(2)}.json`,
}));

const { loadWebMedia } = vi.hoisted(() => ({
  loadWebMedia: vi.fn(),
}));

vi.mock("../web/media.js", () => ({
  loadWebMedia,
}));

const { loadConfig } = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
}));
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

const { readChannelAllowFromStore } = vi.hoisted(() => ({
  readChannelAllowFromStore: vi.fn(async () => [] as string[]),
}));

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore,
  upsertChannelPairingRequest: vi.fn(async () => ({
    code: "PAIRCODE",
    created: true,
  })),
}));

const { enqueueSystemEvent } = vi.hoisted(() => ({
  enqueueSystemEvent: vi.fn(),
}));
vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent,
}));

const { wasSentByBot } = vi.hoisted(() => ({
  wasSentByBot: vi.fn(() => false),
}));
vi.mock("./sent-message-cache.js", () => ({
  wasSentByBot,
  recordSentMessage: vi.fn(),
  clearSentMessageCache: vi.fn(),
}));

const useSpy = vi.fn();
const middlewareUseSpy = vi.fn();
const onSpy = vi.fn();
const stopSpy = vi.fn();
const commandSpy = vi.fn();
const answerCallbackQuerySpy = vi.fn(async () => undefined);
const sendChatActionSpy = vi.fn();
const setMessageReactionSpy = vi.fn(async () => undefined);
const setMyCommandsSpy = vi.fn(async () => undefined);
const sendMessageSpy = vi.fn(async () => ({ message_id: 77 }));
const sendAnimationSpy = vi.fn(async () => ({ message_id: 78 }));
const sendPhotoSpy = vi.fn(async () => ({ message_id: 79 }));

vi.mock("grammy", () => ({
  Bot: class {
    api = {
      config: { use: useSpy },
      answerCallbackQuery: answerCallbackQuerySpy,
      sendChatAction: sendChatActionSpy,
      setMessageReaction: setMessageReactionSpy,
      setMyCommands: setMyCommandsSpy,
      sendMessage: sendMessageSpy,
      sendAnimation: sendAnimationSpy,
      sendPhoto: sendPhotoSpy,
    };
    use = middlewareUseSpy;
    on = onSpy;
    stop = stopSpy;
    command = commandSpy;
    catch = vi.fn();
    constructor(
      public token: string,
      public options?: { client?: { fetch?: typeof fetch } },
    ) {}
  },
  InputFile: class {},
  webhookCallback: vi.fn(),
}));

vi.mock("@grammyjs/runner", () => ({
  sequentialize: () => vi.fn(),
}));

vi.mock("@grammyjs/transformer-throttler", () => ({
  apiThrottler: () => vi.fn(),
}));

vi.mock("../auto-reply/reply.js", () => {
  const replySpy = vi.fn(async (_ctx, opts) => {
    await opts?.onReplyStart?.();
    return undefined;
  });
  return { getReplyFromConfig: replySpy, __replySpy: replySpy };
});

let replyModule: typeof import("../auto-reply/reply.js");

const getOnHandler = (event: string) => {
  const handler = onSpy.mock.calls.find((call) => call[0] === event)?.[1];
  if (!handler) {
    throw new Error(`Missing handler for event: ${event}`);
  }
  return handler as (ctx: Record<string, unknown>) => Promise<void>;
};

describe("createTelegramBot", () => {
  beforeAll(async () => {
    replyModule = await import("../auto-reply/reply.js");
  });

  beforeEach(() => {
    resetInboundDedupe();
    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });
    onSpy.mockReset();
    enqueueSystemEvent.mockReset();
    wasSentByBot.mockReset();
    middlewareUseSpy.mockReset();
  });

  it("does not skip group reactions due to concurrent update offset advancement", async () => {
    // Simulate the race condition: bot starts with persisted offset 99.
    // A message in chat B (update_id 102) would complete before reaction in
    // chat A (update_id 101) due to concurrent sequentialize keys.
    // Before the fix, the runtime-advancing lastUpdateId reached 102 and
    // caused the reaction (101) to be skipped.  After the fix, only the
    // initial persisted offset (99) is used, so 101 > 99 → not skipped.
    createTelegramBot({
      token: "tok",
      updateOffset: {
        lastUpdateId: 99,
        onUpdateId: vi.fn(),
      },
    });

    const reactionHandler = getOnHandler("message_reaction");
    const messageHandler = getOnHandler("message");

    // First: a message from chat B completes (update_id 102 > initial 99)
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();

    await messageHandler({
      update: { update_id: 102 },
      message: {
        chat: { id: -200, type: "supergroup", title: "Chat B" },
        from: { id: 5, username: "user5" },
        text: "hello from B",
        date: 1736380800,
        message_id: 1,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({}),
    });

    // Now: the group reaction from chat A (update_id 101) arrives.
    // Before the fix this would be skipped because 101 <= lastUpdateId (102).
    await reactionHandler({
      update: { update_id: 101 },
      messageReaction: {
        chat: { id: -100, type: "supergroup" },
        message_id: 42,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "👍" }],
      },
    });

    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("👍"),
      expect.objectContaining({
        contextKey: expect.stringContaining("telegram:reaction:add:-100:42:9"),
      }),
    );
  });

  it("still skips updates at or below the persisted initial offset (crash recovery)", async () => {
    createTelegramBot({
      token: "tok",
      updateOffset: {
        lastUpdateId: 200,
        onUpdateId: vi.fn(),
      },
    });

    const reactionHandler = getOnHandler("message_reaction");

    // Reaction with update_id 200 (equal to persisted offset) should be skipped
    await reactionHandler({
      update: { update_id: 200 },
      messageReaction: {
        chat: { id: -100, type: "supergroup" },
        message_id: 50,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "🔥" }],
      },
    });

    expect(enqueueSystemEvent).not.toHaveBeenCalled();

    // Reaction with update_id 150 (below persisted offset) should also be skipped
    await reactionHandler({
      update: { update_id: 150 },
      messageReaction: {
        chat: { id: -100, type: "supergroup" },
        message_id: 51,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "❤️" }],
      },
    });

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("does not skip group messages due to concurrent update offset advancement", async () => {
    // The same race condition also affects regular messages—verify they
    // are not skipped when a cross-chat update advances the offset.
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          reactionNotifications: "all",
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({
      token: "tok",
      updateOffset: {
        lastUpdateId: 99,
        onUpdateId: vi.fn(),
      },
    });

    const messageHandler = getOnHandler("message");
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();

    // Chat B message completes first (update_id 102)
    await messageHandler({
      update: { update_id: 102 },
      message: {
        chat: { id: -200, type: "supergroup", title: "Chat B" },
        from: { id: 5, username: "user5" },
        text: "hello from B",
        date: 1736380800,
        message_id: 1,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({}),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    replySpy.mockReset();

    // Chat A message with lower update_id (101) should NOT be skipped
    await messageHandler({
      update: { update_id: 101 },
      message: {
        chat: { id: -100, type: "supergroup", title: "Chat A" },
        from: { id: 3, username: "user3" },
        text: "hello from A",
        date: 1736380800,
        message_id: 2,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({}),
    });

    // Before the fix, update 101 would be skipped (101 <= 102).
    expect(replySpy).toHaveBeenCalledTimes(1);
  });
});
