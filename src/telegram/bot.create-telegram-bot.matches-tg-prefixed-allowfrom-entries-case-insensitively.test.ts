import { describe, expect, it } from "vitest";
import {
  getLoadConfigMock,
  getOnHandler,
  makeForumGroupMessageCtx,
  onSpy,
  replySpy,
  sendChatActionSpy,
  sendMessageSpy,
} from "./bot.create-telegram-bot.test-harness.js";
import { createTelegramBot } from "./bot.js";

const loadConfig = getLoadConfigMock();

describe("createTelegramBot", () => {
  // groupPolicy tests

  it("matches tg:-prefixed allowFrom entries case-insensitively in group allowlist", async () => {
    onSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          allowFrom: ["TG:123456789"], // Prefixed format (case-insensitive)
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 123456789, username: "testuser" }, // Matches after stripping tg: prefix
        text: "hello from prefixed user",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    // Should call reply because sender ID matches after stripping tg: prefix
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
});
