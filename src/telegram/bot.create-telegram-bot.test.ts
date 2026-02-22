import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Chat, Message } from "@grammyjs/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { escapeRegExp, formatEnvelopeTimestamp } from "../../test/helpers/envelope-timestamp.js";
import { withEnvAsync } from "../test-utils/env.js";
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
const mockChat = (chat: Pick<Chat, "id"> & Partial<Pick<Chat, "type" | "is_forum">>): Chat =>
  chat as Chat;
const mockMessage = (message: Pick<Message, "chat"> & Partial<Message>): Message =>
  ({
    message_id: 1,
    date: 0,
    ...message,
  }) as Message;
const TELEGRAM_TEST_TIMINGS = {
  mediaGroupFlushMs: 20,
  textFragmentGapMs: 30,
} as const;

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
    expect(
      getTelegramSequentialKey({ message: mockMessage({ chat: mockChat({ id: 123 }) }) }),
    ).toBe("telegram:123");
    expect(
      getTelegramSequentialKey({
        message: mockMessage({
          chat: mockChat({ id: 123, type: "private" }),
          message_thread_id: 9,
        }),
      }),
    ).toBe("telegram:123:topic:9");
    expect(
      getTelegramSequentialKey({
        message: mockMessage({
          chat: mockChat({ id: 123, type: "supergroup" }),
          message_thread_id: 9,
        }),
      }),
    ).toBe("telegram:123");
    expect(
      getTelegramSequentialKey({
        message: mockMessage({ chat: mockChat({ id: 123, type: "supergroup", is_forum: true }) }),
      }),
    ).toBe("telegram:123:topic:1");
    expect(
      getTelegramSequentialKey({
        update: { message: mockMessage({ chat: mockChat({ id: 555 }) }) },
      }),
    ).toBe("telegram:555");
    expect(
      getTelegramSequentialKey({
        channelPost: mockMessage({ chat: mockChat({ id: -100777111222, type: "channel" }) }),
      }),
    ).toBe("telegram:-100777111222");
    expect(
      getTelegramSequentialKey({
        update: {
          channel_post: mockMessage({ chat: mockChat({ id: -100777111223, type: "channel" }) }),
        },
      }),
    ).toBe("telegram:-100777111223");
    expect(
      getTelegramSequentialKey({
        message: mockMessage({ chat: mockChat({ id: 123 }), text: "/stop" }),
      }),
    ).toBe("telegram:123:control");
    expect(
      getTelegramSequentialKey({
        message: mockMessage({ chat: mockChat({ id: 123 }), text: "/status" }),
      }),
    ).toBe("telegram:123");
    expect(
      getTelegramSequentialKey({
        message: mockMessage({ chat: mockChat({ id: 123 }), text: "stop" }),
      }),
    ).toBe("telegram:123:control");
    expect(
      getTelegramSequentialKey({
        message: mockMessage({ chat: mockChat({ id: 123 }), text: "stop please" }),
      }),
    ).toBe("telegram:123");
    expect(
      getTelegramSequentialKey({
        message: mockMessage({ chat: mockChat({ id: 123 }), text: "/abort" }),
      }),
    ).toBe("telegram:123");
    expect(
      getTelegramSequentialKey({
        message: mockMessage({ chat: mockChat({ id: 123 }), text: "/abort now" }),
      }),
    ).toBe("telegram:123");
  });
  it("routes callback_query payloads as messages and answers callbacks", async () => {
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
    await withEnvAsync({ TZ: "Europe/Vienna" }, async () => {
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
    });
  });
  it("handles pairing DM flows for new and already-pending requests", async () => {
    const cases = [
      {
        name: "new unknown sender",
        upsertResults: [{ code: "PAIRME12", created: true }],
        messages: ["hello"],
        expectedSendCount: 1,
        expectPairingText: true,
      },
      {
        name: "already pending request",
        upsertResults: [
          { code: "PAIRME12", created: true },
          { code: "PAIRME12", created: false },
        ],
        messages: ["hello", "hello again"],
        expectedSendCount: 1,
        expectPairingText: false,
      },
    ] as const;

    for (const testCase of cases) {
      onSpy.mockClear();
      sendMessageSpy.mockClear();
      replySpy.mockClear();
      loadConfig.mockReturnValue({
        channels: { telegram: { dmPolicy: "pairing" } },
      });
      readChannelAllowFromStore.mockResolvedValue([]);
      upsertChannelPairingRequest.mockClear();
      upsertChannelPairingRequest.mockResolvedValue({ code: "PAIRCODE", created: true });
      for (const result of testCase.upsertResults) {
        upsertChannelPairingRequest.mockResolvedValueOnce(result);
      }

      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
      for (const text of testCase.messages) {
        await handler({
          message: {
            chat: { id: 1234, type: "private" },
            text,
            date: 1736380800,
            from: { id: 999, username: "random" },
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({ download: async () => new Uint8Array() }),
        });
      }

      expect(replySpy, testCase.name).not.toHaveBeenCalled();
      expect(sendMessageSpy, testCase.name).toHaveBeenCalledTimes(testCase.expectedSendCount);
      if (testCase.expectPairingText) {
        expect(sendMessageSpy.mock.calls[0]?.[0], testCase.name).toBe(1234);
        const pairingText = String(sendMessageSpy.mock.calls[0]?.[1]);
        expect(pairingText, testCase.name).toContain("Your Telegram user id: 999");
        expect(pairingText, testCase.name).toContain("Pairing code:");
        expect(pairingText, testCase.name).toContain("PAIRME12");
        expect(pairingText, testCase.name).toContain("openclaw pairing approve telegram PAIRME12");
        expect(pairingText, testCase.name).not.toContain("<code>");
      }
    }
  });
  it("triggers typing cue via onReplyStart", async () => {
    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    await handler({
      message: { chat: { id: 42, type: "private" }, text: "hi" },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(sendChatActionSpy).toHaveBeenCalledWith(42, "typing", undefined);
  });

  it("dedupes duplicate updates for callback_query, message, and channel_post", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          groupPolicy: "open",
          groups: {
            "-100777111222": {
              enabled: true,
              requireMention: false,
            },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    const messageHandler = getOnHandler("message") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    const channelPostHandler = getOnHandler("channel_post") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await callbackHandler({
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
    });
    await callbackHandler({
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
    });
    expect(replySpy).toHaveBeenCalledTimes(1);

    replySpy.mockClear();

    await messageHandler({
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
    });
    await messageHandler({
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
    });
    expect(replySpy).toHaveBeenCalledTimes(1);

    replySpy.mockClear();

    await channelPostHandler({
      channelPost: {
        chat: { id: -100777111222, type: "channel", title: "Wake Channel" },
        from: { id: 98765, is_bot: true, first_name: "wakebot", username: "wake_bot" },
        message_id: 777,
        text: "wake check",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({}),
    });
    await channelPostHandler({
      channelPost: {
        chat: { id: -100777111222, type: "channel", title: "Wake Channel" },
        from: { id: 98765, is_bot: true, first_name: "wakebot", username: "wake_bot" },
        message_id: 777,
        text: "wake check",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({}),
    });
    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("does not persist update offset past pending updates", async () => {
    // For this test we need sequentialize(...) to behave like a normal middleware and call next().
    sequentializeSpy.mockImplementationOnce(
      () => async (_ctx: unknown, next: () => Promise<void>) => {
        await next();
      },
    );

    const onUpdateId = vi.fn();
    loadConfig.mockReturnValue({
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    });

    createTelegramBot({
      token: "tok",
      updateOffset: {
        lastUpdateId: 100,
        onUpdateId,
      },
    });

    type Middleware = (
      ctx: Record<string, unknown>,
      next: () => Promise<void>,
    ) => Promise<void> | void;

    const middlewares = middlewareUseSpy.mock.calls
      .map((call) => call[0])
      .filter((fn): fn is Middleware => typeof fn === "function");

    const runMiddlewareChain = async (
      ctx: Record<string, unknown>,
      finalNext: () => Promise<void>,
    ) => {
      let idx = -1;
      const dispatch = async (i: number): Promise<void> => {
        if (i <= idx) {
          throw new Error("middleware dispatch called multiple times");
        }
        idx = i;
        const fn = middlewares[i];
        if (!fn) {
          await finalNext();
          return;
        }
        await fn(ctx, async () => dispatch(i + 1));
      };
      await dispatch(0);
    };

    let releaseUpdate101: (() => void) | undefined;
    const update101Gate = new Promise<void>((resolve) => {
      releaseUpdate101 = resolve;
    });

    // Start processing update 101 but keep it pending (simulates an update queued behind sequentialize()).
    const p101 = runMiddlewareChain({ update: { update_id: 101 } }, async () => update101Gate);
    // Let update 101 enter the chain and mark itself pending before 102 completes.
    await Promise.resolve();

    // Complete update 102 while 101 is still pending. The persisted watermark must not jump to 102.
    await runMiddlewareChain({ update: { update_id: 102 } }, async () => {});

    const persistedValues = onUpdateId.mock.calls.map((call) => Number(call[0]));
    const maxPersisted = persistedValues.length > 0 ? Math.max(...persistedValues) : -Infinity;
    expect(maxPersisted).toBeLessThan(101);

    releaseUpdate101?.();
    await p101;

    // Once the pending update finishes, the watermark can safely catch up.
    const persistedAfterDrain = onUpdateId.mock.calls.map((call) => Number(call[0]));
    const maxPersistedAfterDrain =
      persistedAfterDrain.length > 0 ? Math.max(...persistedAfterDrain) : -Infinity;
    expect(maxPersistedAfterDrain).toBe(102);
  });
  it("allows distinct callback_query ids without update_id", async () => {
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

  const groupPolicyCases: Array<{
    name: string;
    config: Record<string, unknown>;
    message: Record<string, unknown>;
    expectedReplyCount: number;
  }> = [
    {
      name: "blocks all group messages when groupPolicy is 'disabled'",
      config: {
        channels: {
          telegram: {
            groupPolicy: "disabled",
            allowFrom: ["123456789"],
          },
        },
      },
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 123456789, username: "testuser" },
        text: "@openclaw_bot hello",
        date: 1736380800,
      },
      expectedReplyCount: 0,
    },
    {
      name: "blocks group messages from senders not in allowFrom when groupPolicy is 'allowlist'",
      config: {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            allowFrom: ["123456789"],
          },
        },
      },
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 999999, username: "notallowed" },
        text: "@openclaw_bot hello",
        date: 1736380800,
      },
      expectedReplyCount: 0,
    },
    {
      name: "allows group messages from senders in allowFrom (by ID) when groupPolicy is 'allowlist'",
      config: {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            allowFrom: ["123456789"],
            groups: { "*": { requireMention: false } },
          },
        },
      },
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 123456789, username: "testuser" },
        text: "hello",
        date: 1736380800,
      },
      expectedReplyCount: 1,
    },
    {
      name: "blocks group messages when allowFrom is configured with @username entries (numeric IDs required)",
      config: {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            allowFrom: ["@testuser"],
            groups: { "*": { requireMention: false } },
          },
        },
      },
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 12345, username: "testuser" },
        text: "hello",
        date: 1736380800,
      },
      expectedReplyCount: 0,
    },
    {
      name: "allows group messages from tg:-prefixed allowFrom entries case-insensitively",
      config: {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            allowFrom: ["TG:77112533"],
            groups: { "*": { requireMention: false } },
          },
        },
      },
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 77112533, username: "mneves" },
        text: "hello",
        date: 1736380800,
      },
      expectedReplyCount: 1,
    },
    {
      name: "allows all group messages when groupPolicy is 'open'",
      config: {
        channels: {
          telegram: {
            groupPolicy: "open",
            groups: { "*": { requireMention: false } },
          },
        },
      },
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 999999, username: "random" },
        text: "hello",
        date: 1736380800,
      },
      expectedReplyCount: 1,
    },
  ];

  it("applies groupPolicy cases", async () => {
    for (const [index, testCase] of groupPolicyCases.entries()) {
      resetHarnessSpies();
      loadConfig.mockReturnValue(testCase.config);
      await dispatchMessage({
        message: {
          ...testCase.message,
          message_id: 1_000 + index,
          date: 1_736_380_800 + index,
        },
      });
      expect(replySpy.mock.calls.length, testCase.name).toBe(testCase.expectedReplyCount);
    }
  });

  it("routes DMs by telegram accountId binding", async () => {
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
  it("applies group mention overrides and fallback behavior", async () => {
    const cases: Array<{
      config: Record<string, unknown>;
      message: Record<string, unknown>;
      me?: Record<string, unknown>;
    }> = [
      {
        config: {
          channels: {
            telegram: {
              groupPolicy: "open",
              groups: {
                "*": { requireMention: true },
                "123": { requireMention: false },
              },
            },
          },
        },
        message: {
          chat: { id: 123, type: "group", title: "Dev Chat" },
          text: "hello",
          date: 1736380800,
        },
      },
      {
        config: {
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
        },
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
      },
      {
        config: {
          channels: {
            telegram: {
              groupPolicy: "open",
              groups: { "*": { requireMention: false } },
            },
          },
        },
        message: {
          chat: { id: 456, type: "group", title: "Ops" },
          text: "hello",
          date: 1736380800,
        },
      },
      {
        config: {
          channels: {
            telegram: {
              groupPolicy: "open",
              groups: { "*": { requireMention: true } },
            },
          },
        },
        message: {
          chat: { id: 789, type: "group", title: "No Me" },
          text: "hello",
          date: 1736380800,
        },
        me: {},
      },
    ];

    for (const testCase of cases) {
      resetHarnessSpies();
      loadConfig.mockReturnValue(testCase.config);
      await dispatchMessage({
        message: testCase.message,
        me: testCase.me,
      });
      expect(replySpy).toHaveBeenCalledTimes(1);
    }
  });

  it("routes forum topics to parent or topic-specific bindings", async () => {
    const cases: Array<{
      config: Record<string, unknown>;
      expectedSessionKeyFragment: string;
      text: string;
    }> = [
      {
        config: {
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
        },
        expectedSessionKeyFragment: "agent:forum-agent:",
        text: "hello from topic",
      },
      {
        config: {
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
        },
        expectedSessionKeyFragment: "agent:topic-agent:",
        text: "hello from topic 99",
      },
    ];

    for (const testCase of cases) {
      resetHarnessSpies();
      loadConfig.mockReturnValue(testCase.config);
      await dispatchMessage({
        message: {
          chat: {
            id: -1001234567890,
            type: "supergroup",
            title: "Forum Group",
            is_forum: true,
          },
          text: testCase.text,
          date: 1736380800,
          message_id: 42,
          message_thread_id: 99,
        },
      });
      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0][0];
      expect(payload.SessionKey).toContain(testCase.expectedSessionKeyFragment);
    }
  });

  it("sends GIF replies as animations", async () => {
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
    onSpy.mockClear();
    replySpy.mockClear();
    sendMessageSpy.mockClear();
    setMessageReactionSpy.mockClear();
    setMyCommandsSpy.mockClear();
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

  it("accepts mentionPatterns matches with and without unrelated mentions", async () => {
    const cases = [
      {
        name: "plain mention pattern text",
        message: {
          chat: { id: 7, type: "group", title: "Test Group" },
          text: "bert: introduce yourself",
          date: 1736380800,
          message_id: 1,
          from: { id: 9, first_name: "Ada" },
        },
        assertEnvelope: true,
      },
      {
        name: "mention pattern plus another @mention",
        message: {
          chat: { id: 7, type: "group", title: "Test Group" },
          text: "bert: hello @alice",
          entities: [{ type: "mention", offset: 12, length: 6 }],
          date: 1736380801,
          message_id: 3,
          from: { id: 9, first_name: "Ada" },
        },
        assertEnvelope: false,
      },
    ] as const;

    for (const testCase of cases) {
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
        message: testCase.message,
      });

      expect(replySpy.mock.calls.length, testCase.name).toBe(1);
      const payload = replySpy.mock.calls[0][0];
      expect(payload.WasMentioned, testCase.name).toBe(true);
      if (testCase.assertEnvelope) {
        expect(payload.SenderName).toBe("Ada");
        expect(payload.SenderId).toBe("9");
        const expectedTimestamp = formatEnvelopeTimestamp(new Date("2025-01-09T00:00:00Z"));
        const timestampPattern = escapeRegExp(expectedTimestamp);
        expect(payload.Body).toMatch(
          new RegExp(`^\\[Telegram Test Group id:7 (\\+\\d+[smhd] )?${timestampPattern}\\]`),
        );
      }
    }
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
  it("handles requireMention when mentions do and do not resolve", async () => {
    const cases = [
      {
        name: "mention pattern configured but no match",
        config: { messages: { groupChat: { mentionPatterns: ["\\bbert\\b"] } } },
        me: { username: "openclaw_bot" },
        expectedReplyCount: 0,
        expectedWasMentioned: undefined,
      },
      {
        name: "mention detection unavailable",
        config: { messages: { groupChat: { mentionPatterns: [] } } },
        me: {},
        expectedReplyCount: 1,
        expectedWasMentioned: false,
      },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      resetHarnessSpies();
      loadConfig.mockReturnValue({
        ...testCase.config,
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
          date: 1_736_380_800 + index,
          message_id: 2 + index,
          from: { id: 9, first_name: "Ada" },
        },
        me: testCase.me,
      });

      expect(replySpy.mock.calls.length, testCase.name).toBe(testCase.expectedReplyCount);
      if (testCase.expectedWasMentioned != null) {
        const payload = replySpy.mock.calls[0][0];
        expect(payload.WasMentioned, testCase.name).toBe(testCase.expectedWasMentioned);
      }
    }
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

  it("blocks group messages for restrictive group config edge cases", async () => {
    const blockedCases = [
      {
        name: "allowlist policy with no groupAllowFrom",
        config: {
          channels: {
            telegram: {
              groupPolicy: "allowlist",
              groups: { "*": { requireMention: false } },
            },
          },
        },
        message: {
          chat: { id: -100123456789, type: "group", title: "Test Group" },
          from: { id: 123456789, username: "testuser" },
          text: "hello",
          date: 1736380800,
        },
      },
      {
        name: "groups map without wildcard",
        config: {
          channels: {
            telegram: {
              groups: {
                "123": { requireMention: false },
              },
            },
          },
        },
        message: {
          chat: { id: 456, type: "group", title: "Ops" },
          text: "@openclaw_bot hello",
          date: 1736380800,
        },
      },
    ] as const;

    for (const testCase of blockedCases) {
      resetHarnessSpies();
      loadConfig.mockReturnValue(testCase.config);
      await dispatchMessage({ message: testCase.message });
      expect(replySpy.mock.calls.length, testCase.name).toBe(0);
    }
  });
  it("allows control commands with TG-prefixed groupAllowFrom entries", async () => {
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
  it("handles forum topic metadata and typing thread fallbacks", async () => {
    const forumCases = [
      {
        name: "topic-scoped forum message",
        threadId: 99,
        expectedTypingThreadId: 99,
        assertTopicMetadata: true,
      },
      {
        name: "General topic forum message",
        threadId: undefined,
        expectedTypingThreadId: 1,
        assertTopicMetadata: false,
      },
    ] as const;

    for (const testCase of forumCases) {
      resetHarnessSpies();
      sendChatActionSpy.mockClear();
      loadConfig.mockReturnValue({
        channels: {
          telegram: {
            groupPolicy: "open",
            groups: { "*": { requireMention: false } },
          },
        },
      });

      const handler = getMessageHandler();
      await handler(makeForumGroupMessageCtx({ threadId: testCase.threadId }));

      expect(replySpy.mock.calls.length, testCase.name).toBe(1);
      const payload = replySpy.mock.calls[0][0];
      if (testCase.assertTopicMetadata) {
        expect(payload.SessionKey).toContain("telegram:group:-1001234567890:topic:99");
        expect(payload.From).toBe("telegram:group:-1001234567890:topic:99");
        expect(payload.MessageThreadId).toBe(99);
        expect(payload.IsForum).toBe(true);
      }
      expect(sendChatActionSpy).toHaveBeenCalledWith(-1001234567890, "typing", {
        message_thread_id: testCase.expectedTypingThreadId,
      });
    }
  });
  it("threads forum replies only when a topic id exists", async () => {
    const threadCases = [
      { name: "General topic reply", threadId: undefined, expectedMessageThreadId: undefined },
      { name: "topic reply", threadId: 99, expectedMessageThreadId: 99 },
    ] as const;

    for (const testCase of threadCases) {
      resetHarnessSpies();
      replySpy.mockResolvedValue({ text: "response" });
      loadConfig.mockReturnValue({
        channels: {
          telegram: {
            groupPolicy: "open",
            groups: { "*": { requireMention: false } },
          },
        },
      });

      const handler = getMessageHandler();
      await handler(makeForumGroupMessageCtx({ threadId: testCase.threadId }));

      expect(sendMessageSpy.mock.calls.length, testCase.name).toBe(1);
      const sendParams = sendMessageSpy.mock.calls[0]?.[2] as { message_thread_id?: number };
      if (testCase.expectedMessageThreadId == null) {
        expect(sendParams?.message_thread_id, testCase.name).toBeUndefined();
      } else {
        expect(sendParams?.message_thread_id, testCase.name).toBe(testCase.expectedMessageThreadId);
      }
    }
  });

  const allowFromEdgeCases: Array<{
    name: string;
    config: Record<string, unknown>;
    message: Record<string, unknown>;
    expectedReplyCount: number;
  }> = [
    {
      name: "allows direct messages regardless of groupPolicy",
      config: {
        channels: {
          telegram: {
            groupPolicy: "disabled",
            allowFrom: ["123456789"],
          },
        },
      },
      message: {
        chat: { id: 123456789, type: "private" },
        from: { id: 123456789, username: "testuser" },
        text: "hello",
        date: 1736380800,
      },
      expectedReplyCount: 1,
    },
    {
      name: "allows direct messages with tg/Telegram-prefixed allowFrom entries",
      config: {
        channels: {
          telegram: {
            allowFrom: ["  TG:123456789  "],
          },
        },
      },
      message: {
        chat: { id: 123456789, type: "private" },
        from: { id: 123456789, username: "testuser" },
        text: "hello",
        date: 1736380800,
      },
      expectedReplyCount: 1,
    },
    {
      name: "matches direct message allowFrom against sender user id when chat id differs",
      config: {
        channels: {
          telegram: {
            allowFrom: ["123456789"],
          },
        },
      },
      message: {
        chat: { id: 777777777, type: "private" },
        from: { id: 123456789, username: "testuser" },
        text: "hello",
        date: 1736380800,
      },
      expectedReplyCount: 1,
    },
    {
      name: "falls back to direct message chat id when sender user id is missing",
      config: {
        channels: {
          telegram: {
            allowFrom: ["123456789"],
          },
        },
      },
      message: {
        chat: { id: 123456789, type: "private" },
        text: "hello",
        date: 1736380800,
      },
      expectedReplyCount: 1,
    },
    {
      name: "allows group messages with wildcard in allowFrom when groupPolicy is 'allowlist'",
      config: {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            allowFrom: ["*"],
            groups: { "*": { requireMention: false } },
          },
        },
      },
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 999999, username: "random" },
        text: "hello",
        date: 1736380800,
      },
      expectedReplyCount: 1,
    },
    {
      name: "blocks group messages with no sender ID when groupPolicy is 'allowlist'",
      config: {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            allowFrom: ["123456789"],
          },
        },
      },
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        text: "hello",
        date: 1736380800,
      },
      expectedReplyCount: 0,
    },
  ];

  it("applies allowFrom edge cases", async () => {
    for (const [index, testCase] of allowFromEdgeCases.entries()) {
      resetHarnessSpies();
      loadConfig.mockReturnValue(testCase.config);
      await dispatchMessage({
        message: {
          ...testCase.message,
          message_id: 2_000 + index,
          date: 1_736_380_900 + index,
        },
      });
      expect(replySpy.mock.calls.length, testCase.name).toBe(testCase.expectedReplyCount);
    }
  });
  it("sends replies without native reply threading", async () => {
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
  it("prefixes final replies with responsePrefix", async () => {
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
  it("honors threaded replies for replyToMode=first/all", async () => {
    for (const [mode, messageId] of [
      ["first", 101],
      ["all", 102],
    ] as const) {
      onSpy.mockClear();
      sendMessageSpy.mockClear();
      replySpy.mockClear();
      replySpy.mockResolvedValue({
        text: "a".repeat(4500),
        replyToId: String(messageId),
      });

      createTelegramBot({ token: "tok", replyToMode: mode });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
      await handler({
        message: {
          chat: { id: 5, type: "private" },
          text: "hi",
          date: 1736380800,
          message_id: messageId,
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      expect(sendMessageSpy.mock.calls.length).toBeGreaterThan(1);
      for (const call of sendMessageSpy.mock.calls) {
        expect((call[2] as { reply_to_message_id?: number } | undefined)?.reply_to_message_id).toBe(
          messageId,
        );
      }
    }
  });
  it("honors routed group activation from session store", async () => {
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
  it("threads native command replies inside topics", async () => {
    commandSpy.mockClear();
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
    commandSpy.mockClear();
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
  it("buffers channel_post media groups and processes them together", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: {
            "-100777111222": {
              enabled: true,
              requireMention: false,
            },
          },
        },
      },
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
      const handler = getOnHandler("channel_post") as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;

      const first = handler({
        channelPost: {
          chat: { id: -100777111222, type: "channel", title: "Wake Channel" },
          message_id: 201,
          caption: "album caption",
          date: 1736380800,
          media_group_id: "channel-album-1",
          photo: [{ file_id: "p1" }],
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "photos/p1.jpg" }),
      });

      const second = handler({
        channelPost: {
          chat: { id: -100777111222, type: "channel", title: "Wake Channel" },
          message_id: 202,
          date: 1736380801,
          media_group_id: "channel-album-1",
          photo: [{ file_id: "p2" }],
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "photos/p2.jpg" }),
      });

      await Promise.all([first, second]);
      expect(replySpy).not.toHaveBeenCalled();

      const flushTimerCallIndex = setTimeoutSpy.mock.calls.findLastIndex(
        (call) => call[1] === TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs,
      );
      const flushTimer =
        flushTimerCallIndex >= 0
          ? (setTimeoutSpy.mock.calls[flushTimerCallIndex]?.[0] as (() => unknown) | undefined)
          : undefined;
      // Cancel the real timer so it cannot fire a second time after we manually invoke it.
      if (flushTimerCallIndex >= 0) {
        clearTimeout(
          setTimeoutSpy.mock.results[flushTimerCallIndex]?.value as ReturnType<typeof setTimeout>,
        );
      }
      expect(flushTimer).toBeTypeOf("function");
      await flushTimer?.();

      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0]?.[0] as { Body?: string; MediaPaths?: string[] };
      expect(payload.Body).toContain("album caption");
      expect(payload.MediaPaths).toHaveLength(2);
    } finally {
      setTimeoutSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });
  it("coalesces channel_post near-limit text fragments into one message", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: {
            "-100777111222": {
              enabled: true,
              requireMention: false,
            },
          },
        },
      },
    });

    vi.useFakeTimers();
    try {
      createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
      const handler = getOnHandler("channel_post") as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;

      const part1 = "A".repeat(4050);
      const part2 = "B".repeat(50);

      await handler({
        channelPost: {
          chat: { id: -100777111222, type: "channel", title: "Wake Channel" },
          message_id: 301,
          date: 1736380800,
          text: part1,
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });

      await handler({
        channelPost: {
          chat: { id: -100777111222, type: "channel", title: "Wake Channel" },
          message_id: 302,
          date: 1736380801,
          text: part2,
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });

      expect(replySpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(TELEGRAM_TEST_TIMINGS.textFragmentGapMs + 100);

      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0]?.[0] as { RawBody?: string };
      expect(payload.RawBody).toContain(part1.slice(0, 32));
      expect(payload.RawBody).toContain(part2.slice(0, 32));
    } finally {
      vi.useRealTimers();
    }
  });
  it("drops oversized channel_post media instead of dispatching a placeholder message", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: {
            "-100777111222": {
              enabled: true,
              requireMention: false,
            },
          },
        },
      },
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
    );

    createTelegramBot({ token: "tok", mediaMaxMb: 0 });
    const handler = getOnHandler("channel_post") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      channelPost: {
        chat: { id: -100777111222, type: "channel", title: "Wake Channel" },
        message_id: 401,
        date: 1736380800,
        photo: [{ file_id: "oversized" }],
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ file_path: "photos/oversized.jpg" }),
    });

    expect(replySpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
  it("processes remaining media group photos when one photo download fails", async () => {
    onSpy.mockReset();
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: {
            "-100777111222": {
              enabled: true,
              requireMention: false,
            },
          },
        },
      },
    });

    let fetchCallIndex = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      fetchCallIndex++;
      if (fetchCallIndex === 2) {
        throw new Error("MediaFetchError: Failed to fetch media");
      }
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    });

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
      const handler = getOnHandler("channel_post") as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;

      const first = handler({
        channelPost: {
          chat: { id: -100777111222, type: "channel", title: "Wake Channel" },
          message_id: 401,
          caption: "partial album",
          date: 1736380800,
          media_group_id: "partial-album-1",
          photo: [{ file_id: "p1" }],
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "photos/p1.jpg" }),
      });

      const second = handler({
        channelPost: {
          chat: { id: -100777111222, type: "channel", title: "Wake Channel" },
          message_id: 402,
          date: 1736380801,
          media_group_id: "partial-album-1",
          photo: [{ file_id: "p2" }],
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "photos/p2.jpg" }),
      });

      await Promise.all([first, second]);
      expect(replySpy).not.toHaveBeenCalled();

      const flushTimerCallIndex = setTimeoutSpy.mock.calls.findLastIndex(
        (call) => call[1] === TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs,
      );
      const flushTimer =
        flushTimerCallIndex >= 0
          ? (setTimeoutSpy.mock.calls[flushTimerCallIndex]?.[0] as (() => unknown) | undefined)
          : undefined;
      // Cancel the real timer so it cannot fire a second time after we manually invoke it.
      if (flushTimerCallIndex >= 0) {
        clearTimeout(
          setTimeoutSpy.mock.results[flushTimerCallIndex]?.value as ReturnType<typeof setTimeout>,
        );
      }
      expect(flushTimer).toBeTypeOf("function");
      await flushTimer?.();

      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0]?.[0] as { Body?: string; MediaPaths?: string[] };
      expect(payload.Body).toContain("partial album");
      expect(payload.MediaPaths).toHaveLength(1);
    } finally {
      setTimeoutSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });
  it("drops the media group when a non-recoverable media error occurs", async () => {
    onSpy.mockReset();
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: {
            "-100777111222": {
              enabled: true,
              requireMention: false,
            },
          },
        },
      },
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
      const handler = getOnHandler("channel_post") as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;

      const first = handler({
        channelPost: {
          chat: { id: -100777111222, type: "channel", title: "Wake Channel" },
          message_id: 501,
          caption: "fatal album",
          date: 1736380800,
          media_group_id: "fatal-album-1",
          photo: [{ file_id: "p1" }],
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "photos/p1.jpg" }),
      });

      const second = handler({
        channelPost: {
          chat: { id: -100777111222, type: "channel", title: "Wake Channel" },
          message_id: 502,
          date: 1736380801,
          media_group_id: "fatal-album-1",
          photo: [{ file_id: "p2" }],
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });

      await Promise.all([first, second]);
      expect(replySpy).not.toHaveBeenCalled();

      const flushTimerCallIndex = setTimeoutSpy.mock.calls.findLastIndex(
        (call) => call[1] === TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs,
      );
      const flushTimer =
        flushTimerCallIndex >= 0
          ? (setTimeoutSpy.mock.calls[flushTimerCallIndex]?.[0] as (() => unknown) | undefined)
          : undefined;
      // Cancel the real timer so it cannot fire a second time after we manually invoke it.
      if (flushTimerCallIndex >= 0) {
        clearTimeout(
          setTimeoutSpy.mock.results[flushTimerCallIndex]?.value as ReturnType<typeof setTimeout>,
        );
      }
      expect(flushTimer).toBeTypeOf("function");
      await flushTimer?.();

      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
      fetchSpy.mockRestore();
    }
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
