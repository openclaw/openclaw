import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { escapeRegExp, formatEnvelopeTimestamp } from "../../test/helpers/envelope-timestamp.js";
import {
  answerCallbackQuerySpy,
  botCtorSpy,
  commandSpy,
  getLoadConfigMock,
  getLoadWebMediaMock,
  getOnHandler,
  getReadChannelAllowFromStoreMock,
  getUpsertChannelPairingRequestMock,
  makeForumGroupMessageCtx,
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
  it("applies global and per-account timeoutSeconds", () => {
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
    botCtorSpy.mockClear();

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

  it("dedupes duplicate callback_query updates by update_id", async () => {
    onSpy.mockReset();
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"] },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    const ctx = {
      update: { update_id: 222 },
      callbackQuery: {
        id: "cb-1",
        data: "ping",
        from: { id: 789, username: "testuser" },
        message: {
          chat: { id: 123, type: "private" },
          date: 1736380800,
          message_id: 9001,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({}),
    };

    await handler(ctx);
    await handler(ctx);

    expect(replySpy).toHaveBeenCalledTimes(1);
  });
  it("allows distinct callback_query ids without update_id", async () => {
    onSpy.mockReset();
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"] },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      callbackQuery: {
        id: "cb-1",
        data: "ping",
        from: { id: 789, username: "testuser" },
        message: {
          chat: { id: 123, type: "private" },
          date: 1736380800,
          message_id: 9001,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({}),
    });

    await handler({
      callbackQuery: {
        id: "cb-2",
        data: "ping",
        from: { id: 789, username: "testuser" },
        message: {
          chat: { id: 123, type: "private" },
          date: 1736380800,
          message_id: 9001,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({}),
    });

    expect(replySpy).toHaveBeenCalledTimes(2);
  });

  it("blocks all group messages when groupPolicy is 'disabled'", async () => {
    onSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "disabled",
          allowFrom: ["123456789"],
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 123456789, username: "testuser" },
        text: "@openclaw_bot hello",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).not.toHaveBeenCalled();
  });
  it("blocks group messages from senders not in allowFrom when groupPolicy is 'allowlist'", async () => {
    onSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          allowFrom: ["123456789"],
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 999999, username: "notallowed" },
        text: "@openclaw_bot hello",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).not.toHaveBeenCalled();
  });
  it("allows group messages from senders in allowFrom (by ID) when groupPolicy is 'allowlist'", async () => {
    onSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          allowFrom: ["123456789"],
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 123456789, username: "testuser" },
        text: "hello",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });
  it("blocks group messages when allowFrom is configured with @username entries (numeric IDs required)", async () => {
    onSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          allowFrom: ["@testuser"],
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 12345, username: "testuser" },
        text: "hello",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(0);
  });
  it("allows group messages from telegram:-prefixed allowFrom entries when groupPolicy is 'allowlist'", async () => {
    onSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          allowFrom: ["telegram:77112533"],
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 77112533, username: "mneves" },
        text: "hello",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });
  it("allows group messages from tg:-prefixed allowFrom entries case-insensitively when groupPolicy is 'allowlist'", async () => {
    onSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          allowFrom: ["TG:77112533"],
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 77112533, username: "mneves" },
        text: "hello",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });
  it("allows all group messages when groupPolicy is 'open'", async () => {
    onSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 999999, username: "random" },
        text: "hello",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("routes DMs by telegram accountId binding", async () => {
    onSpy.mockReset();
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          accounts: {
            opie: {
              botToken: "tok-opie",
              dmPolicy: "open",
            },
          },
        },
      },
      bindings: [
        {
          agentId: "opie",
          match: { channel: "telegram", accountId: "opie" },
        },
      ],
    });

    createTelegramBot({ token: "tok", accountId: "opie" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 123, type: "private" },
        from: { id: 999, username: "testuser" },
        text: "hello",
        date: 1736380800,
        message_id: 42,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.AccountId).toBe("opie");
    expect(payload.SessionKey).toBe("agent:opie:main");
  });
  it("allows per-group requireMention override", async () => {
    onSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: {
            "*": { requireMention: true },
            "123": { requireMention: false },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 123, type: "group", title: "Dev Chat" },
        text: "hello",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });
  it("allows per-topic requireMention override", async () => {
    onSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: {
            "*": { requireMention: true },
            "-1001234567890": {
              requireMention: true,
              topics: {
                "99": { requireMention: false },
              },
            },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: {
          id: -1001234567890,
          type: "supergroup",
          title: "Forum Group",
          is_forum: true,
        },
        text: "hello",
        date: 1736380800,
        message_thread_id: 99,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });
  it("honors groups default when no explicit group override exists", async () => {
    onSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 456, type: "group", title: "Ops" },
        text: "hello",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });
  it("does not block group messages when bot username is unknown", async () => {
    onSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 789, type: "group", title: "No Me" },
        text: "hello",
        date: 1736380800,
      },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });
  it("routes forum topic messages using parent group binding", async () => {
    onSpy.mockReset();
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
      agents: {
        list: [{ id: "forum-agent" }],
      },
      bindings: [
        {
          agentId: "forum-agent",
          match: {
            channel: "telegram",
            peer: { kind: "group", id: "-1001234567890" },
          },
        },
      ],
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: {
          id: -1001234567890,
          type: "supergroup",
          title: "Forum Group",
          is_forum: true,
        },
        text: "hello from topic",
        date: 1736380800,
        message_id: 42,
        message_thread_id: 99,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.SessionKey).toContain("agent:forum-agent:");
  });
  it("prefers specific topic binding over parent group binding", async () => {
    onSpy.mockReset();
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
      agents: {
        list: [{ id: "topic-agent" }, { id: "group-agent" }],
      },
      bindings: [
        {
          agentId: "topic-agent",
          match: {
            channel: "telegram",
            peer: { kind: "group", id: "-1001234567890:topic:99" },
          },
        },
        {
          agentId: "group-agent",
          match: {
            channel: "telegram",
            peer: { kind: "group", id: "-1001234567890" },
          },
        },
      ],
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: {
          id: -1001234567890,
          type: "supergroup",
          title: "Forum Group",
          is_forum: true,
        },
        text: "hello from topic 99",
        date: 1736380800,
        message_id: 42,
        message_thread_id: 99,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.SessionKey).toContain("agent:topic-agent:");
  });

  it("sends GIF replies as animations", async () => {
    onSpy.mockReset();
    replySpy.mockReset();

    replySpy.mockResolvedValueOnce({
      text: "caption",
      mediaUrl: "https://example.com/fun",
    });

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("GIF89a"),
      contentType: "image/gif",
      fileName: "fun.gif",
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 1234, type: "private" },
        text: "hello world",
        date: 1736380800,
        message_id: 5,
        from: { first_name: "Ada" },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(sendAnimationSpy).toHaveBeenCalledTimes(1);
    expect(sendAnimationSpy).toHaveBeenCalledWith("1234", expect.anything(), {
      caption: "caption",
      parse_mode: "HTML",
      reply_to_message_id: undefined,
    });
    expect(sendPhotoSpy).not.toHaveBeenCalled();
  });

  function resetHarnessSpies() {
    onSpy.mockReset();
    replySpy.mockReset();
    sendMessageSpy.mockReset();
    setMessageReactionSpy.mockReset();
    setMyCommandsSpy.mockReset();
  }
  function getMessageHandler() {
    createTelegramBot({ token: "tok" });
    return getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
  }
  async function dispatchMessage(params: {
    message: Record<string, unknown>;
    me?: Record<string, unknown>;
  }) {
    const handler = getMessageHandler();
    await handler({
      message: params.message,
      me: params.me ?? { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });
  }

  it("accepts group messages when mentionPatterns match (without @botUsername)", async () => {
    resetHarnessSpies();

    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      identity: { name: "Bert" },
      messages: { groupChat: { mentionPatterns: ["\\bbert\\b"] } },
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
      },
    });

    await dispatchMessage({
      message: {
        chat: { id: 7, type: "group", title: "Test Group" },
        text: "bert: introduce yourself",
        date: 1736380800,
        message_id: 1,
        from: { id: 9, first_name: "Ada" },
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.WasMentioned).toBe(true);
    expect(payload.SenderName).toBe("Ada");
    expect(payload.SenderId).toBe("9");
    const expectedTimestamp = formatEnvelopeTimestamp(new Date("2025-01-09T00:00:00Z"));
    const timestampPattern = escapeRegExp(expectedTimestamp);
    expect(payload.Body).toMatch(
      new RegExp(`^\\[Telegram Test Group id:7 (\\+\\d+[smhd] )?${timestampPattern}\\]`),
    );
  });
  it("accepts group messages when mentionPatterns match even if another user is mentioned", async () => {
    resetHarnessSpies();

    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      identity: { name: "Bert" },
      messages: { groupChat: { mentionPatterns: ["\\bbert\\b"] } },
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
      },
    });

    await dispatchMessage({
      message: {
        chat: { id: 7, type: "group", title: "Test Group" },
        text: "bert: hello @alice",
        entities: [{ type: "mention", offset: 12, length: 6 }],
        date: 1736380800,
        message_id: 3,
        from: { id: 9, first_name: "Ada" },
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(replySpy.mock.calls[0][0].WasMentioned).toBe(true);
  });
  it("keeps group envelope headers stable (sender identity is separate)", async () => {
    resetHarnessSpies();

    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    await dispatchMessage({
      message: {
        chat: { id: 42, type: "group", title: "Ops" },
        text: "hello",
        date: 1736380800,
        message_id: 2,
        from: {
          id: 99,
          first_name: "Ada",
          last_name: "Lovelace",
          username: "ada",
        },
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.SenderName).toBe("Ada Lovelace");
    expect(payload.SenderId).toBe("99");
    expect(payload.SenderUsername).toBe("ada");
    const expectedTimestamp = formatEnvelopeTimestamp(new Date("2025-01-09T00:00:00Z"));
    const timestampPattern = escapeRegExp(expectedTimestamp);
    expect(payload.Body).toMatch(
      new RegExp(`^\\[Telegram Ops id:42 (\\+\\d+[smhd] )?${timestampPattern}\\]`),
    );
  });
  it("reacts to mention-gated group messages when ackReaction is enabled", async () => {
    resetHarnessSpies();

    loadConfig.mockReturnValue({
      messages: {
        ackReaction: "👀",
        ackReactionScope: "group-mentions",
        groupChat: { mentionPatterns: ["\\bbert\\b"] },
      },
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
      },
    });

    await dispatchMessage({
      message: {
        chat: { id: 7, type: "group", title: "Test Group" },
        text: "bert hello",
        date: 1736380800,
        message_id: 123,
        from: { id: 9, first_name: "Ada" },
      },
    });

    expect(setMessageReactionSpy).toHaveBeenCalledWith(7, 123, [{ type: "emoji", emoji: "👀" }]);
  });
  it("clears native commands when disabled", () => {
    resetHarnessSpies();
    loadConfig.mockReturnValue({
      commands: { native: false },
    });

    createTelegramBot({ token: "tok" });

    expect(setMyCommandsSpy).toHaveBeenCalledWith([]);
  });
  it("skips group messages when requireMention is enabled and no mention matches", async () => {
    resetHarnessSpies();

    loadConfig.mockReturnValue({
      messages: { groupChat: { mentionPatterns: ["\\bbert\\b"] } },
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
      },
    });

    await dispatchMessage({
      message: {
        chat: { id: 7, type: "group", title: "Test Group" },
        text: "hello everyone",
        date: 1736380800,
        message_id: 2,
        from: { id: 9, first_name: "Ada" },
      },
    });

    expect(replySpy).not.toHaveBeenCalled();
  });
  it("allows group messages when requireMention is enabled but mentions cannot be detected", async () => {
    resetHarnessSpies();

    loadConfig.mockReturnValue({
      messages: { groupChat: { mentionPatterns: [] } },
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
      },
    });

    await dispatchMessage({
      message: {
        chat: { id: 7, type: "group", title: "Test Group" },
        text: "hello everyone",
        date: 1736380800,
        message_id: 3,
        from: { id: 9, first_name: "Ada" },
      },
      me: {},
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.WasMentioned).toBe(false);
  });
  it("includes reply-to context when a Telegram reply is received", async () => {
    resetHarnessSpies();

    await dispatchMessage({
      message: {
        chat: { id: 7, type: "private" },
        text: "Sure, see below",
        date: 1736380800,
        reply_to_message: {
          message_id: 9001,
          text: "Can you summarize this?",
          from: { first_name: "Ada" },
        },
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.Body).toContain("[Replying to Ada id:9001]");
    expect(payload.Body).toContain("Can you summarize this?");
    expect(payload.ReplyToId).toBe("9001");
    expect(payload.ReplyToBody).toBe("Can you summarize this?");
    expect(payload.ReplyToSender).toBe("Ada");
  });

  it("matches tg:-prefixed allowFrom entries case-insensitively in group allowlist", async () => {
    onSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          allowFrom: ["TG:123456789"],
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 123456789, username: "testuser" },
        text: "hello from prefixed user",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalled();
  });
  it("blocks group messages when groupPolicy allowlist has no groupAllowFrom", async () => {
    onSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 123456789, username: "testuser" },
        text: "hello",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).not.toHaveBeenCalled();
  });
  it("allows control commands with TG-prefixed groupAllowFrom entries", async () => {
    onSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["  TG:123456789  "],
          groups: { "*": { requireMention: true } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 123456789, username: "testuser" },
        text: "/status",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });
  it("isolates forum topic sessions and carries thread metadata", async () => {
    onSpy.mockReset();
    sendChatActionSpy.mockReset();
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler(makeForumGroupMessageCtx({ threadId: 99 }));

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.SessionKey).toContain("telegram:group:-1001234567890:topic:99");
    expect(payload.From).toBe("telegram:group:-1001234567890:topic:99");
    expect(payload.MessageThreadId).toBe(99);
    expect(payload.IsForum).toBe(true);
    expect(sendChatActionSpy).toHaveBeenCalledWith(-1001234567890, "typing", {
      message_thread_id: 99,
    });
  });
  it("falls back to General topic thread id for typing in forums", async () => {
    onSpy.mockReset();
    sendChatActionSpy.mockReset();
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler(makeForumGroupMessageCtx({ threadId: undefined }));

    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(sendChatActionSpy).toHaveBeenCalledWith(-1001234567890, "typing", {
      message_thread_id: 1,
    });
  });
  it("routes General topic replies using thread id 1", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    replySpy.mockReset();
    replySpy.mockResolvedValue({ text: "response" });

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: {
          id: -1001234567890,
          type: "supergroup",
          title: "Forum Group",
          is_forum: true,
        },
        from: { id: 12345, username: "testuser" },
        text: "hello",
        date: 1736380800,
        message_id: 42,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    const sendParams = sendMessageSpy.mock.calls[0]?.[2] as { message_thread_id?: number };
    expect(sendParams?.message_thread_id).toBeUndefined();
  });

  it("allows direct messages regardless of groupPolicy", async () => {
    onSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "disabled",
          allowFrom: ["123456789"],
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 123456789, type: "private" },
        from: { id: 123456789, username: "testuser" },
        text: "hello",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });
  it("allows direct messages with tg/Telegram-prefixed allowFrom entries", async () => {
    onSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          allowFrom: ["  TG:123456789  "],
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 123456789, type: "private" },
        from: { id: 123456789, username: "testuser" },
        text: "hello",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });
  it("matches direct message allowFrom against sender user id when chat id differs", async () => {
    onSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          allowFrom: ["123456789"],
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 777777777, type: "private" },
        from: { id: 123456789, username: "testuser" },
        text: "hello",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });
  it("falls back to direct message chat id when sender user id is missing", async () => {
    onSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          allowFrom: ["123456789"],
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 123456789, type: "private" },
        text: "hello",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });
  it("allows group messages with wildcard in allowFrom when groupPolicy is 'allowlist'", async () => {
    onSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          allowFrom: ["*"],
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 999999, username: "random" },
        text: "hello",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });
  it("blocks group messages with no sender ID when groupPolicy is 'allowlist'", async () => {
    onSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          allowFrom: ["123456789"],
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        text: "hello",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).not.toHaveBeenCalled();
  });
  it("sends replies without native reply threading", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    replySpy.mockReset();
    replySpy.mockResolvedValue({ text: "a".repeat(4500) });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    await handler({
      message: {
        chat: { id: 5, type: "private" },
        text: "hi",
        date: 1736380800,
        message_id: 101,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(sendMessageSpy.mock.calls.length).toBeGreaterThan(1);
    for (const call of sendMessageSpy.mock.calls) {
      expect(
        (call[2] as { reply_to_message_id?: number } | undefined)?.reply_to_message_id,
      ).toBeUndefined();
    }
  });
  it("honors replyToMode=first for threaded replies", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    replySpy.mockReset();
    replySpy.mockResolvedValue({
      text: "a".repeat(4500),
      replyToId: "101",
    });

    createTelegramBot({ token: "tok", replyToMode: "first" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    await handler({
      message: {
        chat: { id: 5, type: "private" },
        text: "hi",
        date: 1736380800,
        message_id: 101,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(sendMessageSpy.mock.calls.length).toBeGreaterThan(1);
    const [first, ...rest] = sendMessageSpy.mock.calls;
    expect((first?.[2] as { reply_to_message_id?: number } | undefined)?.reply_to_message_id).toBe(
      101,
    );
    for (const call of rest) {
      expect(
        (call[2] as { reply_to_message_id?: number } | undefined)?.reply_to_message_id,
      ).toBeUndefined();
    }
  });
  it("prefixes final replies with responsePrefix", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    replySpy.mockReset();
    replySpy.mockResolvedValue({ text: "final reply" });
    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"] },
      },
      messages: { responsePrefix: "PFX" },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    await handler({
      message: {
        chat: { id: 5, type: "private" },
        text: "hi",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy.mock.calls[0][1]).toBe("PFX final reply");
  });
  it("honors replyToMode=all for threaded replies", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    replySpy.mockReset();
    replySpy.mockResolvedValue({
      text: "a".repeat(4500),
      replyToId: "101",
    });

    createTelegramBot({ token: "tok", replyToMode: "all" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    await handler({
      message: {
        chat: { id: 5, type: "private" },
        text: "hi",
        date: 1736380800,
        message_id: 101,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(sendMessageSpy.mock.calls.length).toBeGreaterThan(1);
    for (const call of sendMessageSpy.mock.calls) {
      expect((call[2] as { reply_to_message_id?: number } | undefined)?.reply_to_message_id).toBe(
        101,
      );
    }
  });
  it("blocks group messages when telegram.groups is set without a wildcard", async () => {
    onSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groups: {
            "123": { requireMention: false },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 456, type: "group", title: "Ops" },
        text: "@openclaw_bot hello",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).not.toHaveBeenCalled();
  });
  it("honors routed group activation from session store", async () => {
    onSpy.mockReset();
    replySpy.mockReset();
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-"));
    const storePath = path.join(storeDir, "sessions.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:ops:telegram:group:123": { groupActivation: "always" },
      }),
      "utf-8",
    );
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
      },
      bindings: [
        {
          agentId: "ops",
          match: {
            channel: "telegram",
            peer: { kind: "group", id: "123" },
          },
        },
      ],
      session: { store: storePath },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 123, type: "group", title: "Routing" },
        text: "hello",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("applies topic skill filters and system prompts", async () => {
    onSpy.mockReset();
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: {
            "-1001234567890": {
              requireMention: false,
              systemPrompt: "Group prompt",
              skills: ["group-skill"],
              topics: {
                "99": {
                  skills: [],
                  systemPrompt: "Topic prompt",
                },
              },
            },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler(makeForumGroupMessageCtx({ threadId: 99 }));

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.GroupSystemPrompt).toBe("Group prompt\n\nTopic prompt");
    const opts = replySpy.mock.calls[0][1] as { skillFilter?: unknown };
    expect(opts?.skillFilter).toEqual([]);
  });
  it("passes message_thread_id to topic replies", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    commandSpy.mockReset();
    replySpy.mockReset();
    replySpy.mockResolvedValue({ text: "response" });

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler(makeForumGroupMessageCtx({ threadId: 99 }));

    expect(sendMessageSpy).toHaveBeenCalledWith(
      "-1001234567890",
      expect.any(String),
      expect.objectContaining({ message_thread_id: 99 }),
    );
  });
  it("threads native command replies inside topics", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    commandSpy.mockReset();
    replySpy.mockReset();
    replySpy.mockResolvedValue({ text: "response" });

    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    expect(commandSpy).toHaveBeenCalled();
    const handler = commandSpy.mock.calls[0][1] as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      ...makeForumGroupMessageCtx({ threadId: 99, text: "/status" }),
      match: "",
    });

    expect(sendMessageSpy).toHaveBeenCalledWith(
      "-1001234567890",
      expect.any(String),
      expect.objectContaining({ message_thread_id: 99 }),
    );
  });
  it("skips tool summaries for native slash commands", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    commandSpy.mockReset();
    replySpy.mockReset();
    replySpy.mockImplementation(async (_ctx, opts) => {
      await opts?.onToolResult?.({ text: "tool update" });
      return { text: "final reply" };
    });

    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const verboseHandler = commandSpy.mock.calls.find((call) => call[0] === "verbose")?.[1] as
      | ((ctx: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!verboseHandler) {
      throw new Error("verbose command handler missing");
    }

    await verboseHandler({
      message: {
        chat: { id: 12345, type: "private" },
        from: { id: 12345, username: "testuser" },
        text: "/verbose on",
        date: 1736380800,
        message_id: 42,
      },
      match: "on",
    });

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy.mock.calls[0]?.[1]).toContain("final reply");
  });
  it("dedupes duplicate message updates by update_id", async () => {
    onSpy.mockReset();
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"] },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    const ctx = {
      update: { update_id: 111 },
      message: {
        chat: { id: 123, type: "private" },
        from: { id: 456, username: "testuser" },
        text: "hello",
        date: 1736380800,
        message_id: 42,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    };

    await handler(ctx);
    await handler(ctx);

    expect(replySpy).toHaveBeenCalledTimes(1);
  });
});
