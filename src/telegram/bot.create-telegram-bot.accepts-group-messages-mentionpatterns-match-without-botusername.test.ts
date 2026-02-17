import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { escapeRegExp, formatEnvelopeTimestamp } from "../../test/helpers/envelope-timestamp.js";
import {
  getOnHandler,
  getLoadConfigMock,
  onSpy,
  replySpy,
  sendMessageSpy,
  setMessageReactionSpy,
  setMyCommandsSpy,
} from "./bot.create-telegram-bot.test-harness.js";
import { createTelegramBot } from "./bot.js";

const loadConfig = getLoadConfigMock();

const ORIGINAL_TZ = process.env.TZ;
describe("createTelegramBot", () => {
  beforeEach(() => {
    process.env.TZ = "UTC";
  });
  afterEach(() => {
    process.env.TZ = ORIGINAL_TZ;
  });

  // groupPolicy tests

  it("accepts group messages when mentionPatterns match (without @botUsername)", async () => {
    onSpy.mockReset();
    replySpy.mockReset();

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

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 7, type: "group", title: "Test Group" },
        text: "bert: introduce yourself",
        date: 1736380800,
        message_id: 1,
        from: { id: 9, first_name: "Ada" },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
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
    onSpy.mockReset();
    replySpy.mockReset();

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

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 7, type: "group", title: "Test Group" },
        text: "bert: hello @alice",
        entities: [{ type: "mention", offset: 12, length: 6 }],
        date: 1736380800,
        message_id: 3,
        from: { id: 9, first_name: "Ada" },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(replySpy.mock.calls[0][0].WasMentioned).toBe(true);
  });

  it("keeps group envelope headers stable (sender identity is separate)", async () => {
    onSpy.mockReset();
    replySpy.mockReset();

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

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
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
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
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
    onSpy.mockReset();
    setMessageReactionSpy.mockReset();
    replySpy.mockReset();

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

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 7, type: "group", title: "Test Group" },
        text: "bert hello",
        date: 1736380800,
        message_id: 123,
        from: { id: 9, first_name: "Ada" },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(setMessageReactionSpy).toHaveBeenCalledWith(7, 123, [{ type: "emoji", emoji: "👀" }]);
  });
  it("clears native commands when disabled", () => {
    loadConfig.mockReturnValue({
      commands: { native: false },
    });

    createTelegramBot({ token: "tok" });

    expect(setMyCommandsSpy).toHaveBeenCalledWith([]);
  });
  it("skips group messages when requireMention is enabled and no mention matches", async () => {
    onSpy.mockReset();
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      messages: { groupChat: { mentionPatterns: ["\\bbert\\b"] } },
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
        chat: { id: 7, type: "group", title: "Test Group" },
        text: "hello everyone",
        date: 1736380800,
        message_id: 2,
        from: { id: 9, first_name: "Ada" },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).not.toHaveBeenCalled();
  });
  it("allows group messages when requireMention is enabled but mentions cannot be detected", async () => {
    onSpy.mockReset();
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      messages: { groupChat: { mentionPatterns: [] } },
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
        chat: { id: 7, type: "group", title: "Test Group" },
        text: "hello everyone",
        date: 1736380800,
        message_id: 3,
        from: { id: 9, first_name: "Ada" },
      },
      me: {},
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.WasMentioned).toBe(false);
  });
  it("includes reply-to context when a Telegram reply is received", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    replySpy.mockReset();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
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
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.Body).toContain("[Replying to Ada id:9001]");
    expect(payload.Body).toContain("Can you summarize this?");
    expect(payload.ReplyToId).toBe("9001");
    expect(payload.ReplyToBody).toBe("Can you summarize this?");
    expect(payload.ReplyToSender).toBe("Ada");
  });
});
