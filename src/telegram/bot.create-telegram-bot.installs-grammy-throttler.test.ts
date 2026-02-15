import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { escapeRegExp, formatEnvelopeTimestamp } from "../../test/helpers/envelope-timestamp.js";
import {
  answerCallbackQuerySpy,
  botCtorSpy,
  getLoadConfigMock,
  getLoadWebMediaMock,
  getOnHandler,
  getReadChannelAllowFromStoreMock,
  getUpsertChannelPairingRequestMock,
  middlewareUseSpy,
  onSpy,
  replySpy,
  sendAnimationSpy,
  sendChatActionSpy,
  sendMessageSpy,
  sendPhotoSpy,
  sequentializeKey,
  sequentializeSpy,
  setMessageReactionSpy,
  setMyCommandsSpy,
  throttlerSpy,
  useSpy,
} from "./bot.create-telegram-bot.test-harness.js";
import { createTelegramBot, getTelegramSequentialKey } from "./bot.js";
import { resolveTelegramFetch } from "./fetch.js";

const loadConfig = getLoadConfigMock();
const loadWebMedia = getLoadWebMediaMock();
const readChannelAllowFromStore = getReadChannelAllowFromStoreMock();
const upsertChannelPairingRequest = getUpsertChannelPairingRequestMock();

const ORIGINAL_TZ = process.env.TZ;

describe("createTelegramBot", () => {
  beforeEach(() => {
    process.env.TZ = "UTC";
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"] },
      },
    });
    loadWebMedia.mockReset();
    sendAnimationSpy.mockReset();
    sendPhotoSpy.mockReset();
    setMessageReactionSpy.mockReset();
    answerCallbackQuerySpy.mockReset();
    setMyCommandsSpy.mockReset();
    middlewareUseSpy.mockReset();
    sequentializeSpy.mockReset();
    botCtorSpy.mockReset();
  });
  afterEach(() => {
    process.env.TZ = ORIGINAL_TZ;
  });

  // groupPolicy tests

  it("installs grammY throttler", () => {
    createTelegramBot({ token: "tok" });
    expect(throttlerSpy).toHaveBeenCalledTimes(1);
    expect(useSpy).toHaveBeenCalledWith("throttler");
  });
  it("uses wrapped fetch when global fetch is available", () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn() as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    try {
      createTelegramBot({ token: "tok" });
      const fetchImpl = resolveTelegramFetch();
      expect(fetchImpl).toBeTypeOf("function");
      expect(fetchImpl).not.toBe(fetchSpy);
      const clientFetch = (botCtorSpy.mock.calls[0]?.[1] as { client?: { fetch?: unknown } })
        ?.client?.fetch;
      expect(clientFetch).toBeTypeOf("function");
      expect(clientFetch).not.toBe(fetchSpy);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  it("passes timeoutSeconds even without a custom fetch", () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"], timeoutSeconds: 60 },
      },
    });
    createTelegramBot({ token: "tok" });
    expect(botCtorSpy).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({
        client: expect.objectContaining({ timeoutSeconds: 60 }),
      }),
    );
  });
  it("prefers per-account timeoutSeconds overrides", () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          timeoutSeconds: 60,
          accounts: {
            foo: { timeoutSeconds: 61 },
          },
        },
      },
    });
    createTelegramBot({ token: "tok", accountId: "foo" });
    expect(botCtorSpy).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({
        client: expect.objectContaining({ timeoutSeconds: 61 }),
      }),
    );
  });
  it("sequentializes updates by chat and thread", () => {
    createTelegramBot({ token: "tok" });
    expect(sequentializeSpy).toHaveBeenCalledTimes(1);
    expect(middlewareUseSpy).toHaveBeenCalledWith(sequentializeSpy.mock.results[0]?.value);
    expect(sequentializeKey).toBe(getTelegramSequentialKey);
    expect(getTelegramSequentialKey({ message: { chat: { id: 123 } } })).toBe("telegram:123");
    expect(
      getTelegramSequentialKey({
        message: { chat: { id: 123, type: "private" }, message_thread_id: 9 },
      }),
    ).toBe("telegram:123:topic:9");
    expect(
      getTelegramSequentialKey({
        message: { chat: { id: 123, type: "supergroup" }, message_thread_id: 9 },
      }),
    ).toBe("telegram:123");
    expect(
      getTelegramSequentialKey({
        message: { chat: { id: 123, type: "supergroup", is_forum: true } },
      }),
    ).toBe("telegram:123:topic:1");
    expect(
      getTelegramSequentialKey({
        update: { message: { chat: { id: 555 } } },
      }),
    ).toBe("telegram:555");
    expect(
      getTelegramSequentialKey({
        message: { chat: { id: 123 }, text: "/stop" },
      }),
    ).toBe("telegram:123:control");
    expect(
      getTelegramSequentialKey({
        message: { chat: { id: 123 }, text: "/status" },
      }),
    ).toBe("telegram:123:control");
    expect(
      getTelegramSequentialKey({
        message: { chat: { id: 123 }, text: "stop" },
      }),
    ).toBe("telegram:123:control");
  });
  it("routes callback_query payloads as messages and answers callbacks", async () => {
    onSpy.mockReset();
    replySpy.mockReset();

    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-1",
        data: "cmd:option_a",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 10,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.Body).toContain("cmd:option_a");
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-1");
  });
  it("wraps inbound message with Telegram envelope", async () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "Europe/Vienna";

    try {
      onSpy.mockReset();
      replySpy.mockReset();

      createTelegramBot({ token: "tok" });
      expect(onSpy).toHaveBeenCalledWith("message", expect.any(Function));
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      const message = {
        chat: { id: 1234, type: "private" },
        text: "hello world",
        date: 1736380800, // 2025-01-09T00:00:00Z
        from: {
          first_name: "Ada",
          last_name: "Lovelace",
          username: "ada_bot",
        },
      };
      await handler({
        message,
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0][0];
      const expectedTimestamp = formatEnvelopeTimestamp(new Date("2025-01-09T00:00:00Z"));
      const timestampPattern = escapeRegExp(expectedTimestamp);
      expect(payload.Body).toMatch(
        new RegExp(
          `^\\[Telegram Ada Lovelace \\(@ada_bot\\) id:1234 (\\+\\d+[smhd] )?${timestampPattern}\\]`,
        ),
      );
      expect(payload.Body).toContain("hello world");
    } finally {
      process.env.TZ = originalTz;
    }
  });
  it("requests pairing by default for unknown DM senders", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      channels: { telegram: { dmPolicy: "pairing" } },
    });
    readChannelAllowFromStore.mockResolvedValue([]);
    upsertChannelPairingRequest.mockResolvedValue({
      code: "PAIRME12",
      created: true,
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 1234, type: "private" },
        text: "hello",
        date: 1736380800,
        from: { id: 999, username: "random" },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy.mock.calls[0]?.[0]).toBe(1234);
    const pairingText = String(sendMessageSpy.mock.calls[0]?.[1]);
    expect(pairingText).toContain("Your Telegram user id: 999");
    expect(pairingText).toContain("Pairing code:");
    expect(pairingText).toContain("PAIRME12");
    expect(pairingText).toContain("openclaw pairing approve telegram PAIRME12");
    expect(pairingText).not.toContain("<code>");
  });
  it("does not resend pairing code when a request is already pending", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      channels: { telegram: { dmPolicy: "pairing" } },
    });
    readChannelAllowFromStore.mockResolvedValue([]);
    upsertChannelPairingRequest
      .mockResolvedValueOnce({ code: "PAIRME12", created: true })
      .mockResolvedValueOnce({ code: "PAIRME12", created: false });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    const message = {
      chat: { id: 1234, type: "private" },
      text: "hello",
      date: 1736380800,
      from: { id: 999, username: "random" },
    };

    await handler({
      message,
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });
    await handler({
      message: { ...message, text: "hello again" },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });
  it("triggers typing cue via onReplyStart", async () => {
    onSpy.mockReset();
    sendChatActionSpy.mockReset();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    await handler({
      message: { chat: { id: 42, type: "private" }, text: "hi" },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(sendChatActionSpy).toHaveBeenCalledWith(42, "typing", undefined);
  });
});
