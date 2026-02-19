import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { escapeRegExp, formatEnvelopeTimestamp } from "../../test/helpers/envelope-timestamp.js";
import { expectInboundContextContract } from "../../test/helpers/inbound-contract.js";
import {
  listNativeCommandSpecs,
  listNativeCommandSpecsForConfig,
} from "../auto-reply/commands-registry.js";
import { normalizeTelegramCommandName } from "../config/telegram-custom-commands.js";
import {
  answerCallbackQuerySpy,
  commandSpy,
  editMessageReplyMarkupSpy,
  editMessageTextSpy,
  enqueueSystemEventSpy,
  getLoadConfigMock,
  getReadChannelAllowFromStoreMock,
  getOnHandler,
  listSkillCommandsForAgents,
  middlewareUseSpy,
  onSpy,
  replySpy,
  sendMessageSpy,
  setMyCommandsSpy,
  wasSentByBot,
} from "./bot.create-telegram-bot.test-harness.js";
import { createTelegramBot } from "./bot.js";

const loadConfig = getLoadConfigMock();
const readChannelAllowFromStore = getReadChannelAllowFromStoreMock();

function resolveSkillCommands(config: Parameters<typeof listNativeCommandSpecsForConfig>[0]) {
  void config;
  return listSkillCommandsForAgents() as NonNullable<
    Parameters<typeof listNativeCommandSpecsForConfig>[1]
  >["skillCommands"];
}

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
  });
  afterEach(() => {
    process.env.TZ = ORIGINAL_TZ;
  });

  it("merges custom commands with native commands", () => {
    const config = {
      channels: {
        telegram: {
          customCommands: [
            { command: "custom_backup", description: "Git backup" },
            { command: "/Custom_Generate", description: "Create an image" },
          ],
        },
      },
    };
    loadConfig.mockReturnValue(config);

    createTelegramBot({ token: "tok" });

    const registered = setMyCommandsSpy.mock.calls[0]?.[0] as Array<{
      command: string;
      description: string;
    }>;
    const skillCommands = resolveSkillCommands(config);
    const native = listNativeCommandSpecsForConfig(config, { skillCommands }).map((command) => ({
      command: normalizeTelegramCommandName(command.name),
      description: command.description,
    }));
    expect(registered.slice(0, native.length)).toEqual(native);
    expect(registered.slice(native.length)).toEqual([
      { command: "custom_backup", description: "Git backup" },
      { command: "custom_generate", description: "Create an image" },
    ]);
  });

  it("ignores custom commands that collide with native commands", () => {
    const errorSpy = vi.fn();
    const config = {
      channels: {
        telegram: {
          customCommands: [
            { command: "status", description: "Custom status" },
            { command: "custom_backup", description: "Git backup" },
          ],
        },
      },
    };
    loadConfig.mockReturnValue(config);

    createTelegramBot({
      token: "tok",
      runtime: {
        log: vi.fn(),
        error: errorSpy,
        exit: ((code: number) => {
          throw new Error(`exit ${code}`);
        }) as (code: number) => never,
      },
    });

    const registered = setMyCommandsSpy.mock.calls[0]?.[0] as Array<{
      command: string;
      description: string;
    }>;
    const skillCommands = resolveSkillCommands(config);
    const native = listNativeCommandSpecsForConfig(config, { skillCommands }).map((command) => ({
      command: normalizeTelegramCommandName(command.name),
      description: command.description,
    }));
    const nativeStatus = native.find((command) => command.command === "status");
    expect(nativeStatus).toBeDefined();
    expect(registered).toContainEqual({ command: "custom_backup", description: "Git backup" });
    expect(registered).not.toContainEqual({ command: "status", description: "Custom status" });
    expect(registered.filter((command) => command.command === "status")).toEqual([nativeStatus]);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("registers custom commands when native commands are disabled", () => {
    const config = {
      commands: { native: false },
      channels: {
        telegram: {
          customCommands: [
            { command: "custom_backup", description: "Git backup" },
            { command: "custom_generate", description: "Create an image" },
          ],
        },
      },
    };
    loadConfig.mockReturnValue(config);

    createTelegramBot({ token: "tok" });

    const registered = setMyCommandsSpy.mock.calls[0]?.[0] as Array<{
      command: string;
      description: string;
    }>;
    expect(registered).toEqual([
      { command: "custom_backup", description: "Git backup" },
      { command: "custom_generate", description: "Create an image" },
    ]);
    const reserved = new Set(listNativeCommandSpecs().map((command) => command.name));
    expect(registered.some((command) => reserved.has(command.command))).toBe(false);
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

  it("supports callback direct mode without forwarding unhandled payloads", async () => {
    onSpy.mockReset();
    replySpy.mockReset();

    createTelegramBot({
      token: "tok",
      config: {
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
            callback: { enabled: true, forwardUnhandled: false },
          },
        },
      },
    });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await callbackHandler({
      callbackQuery: {
        id: "cbq-direct-1",
        data: "plain_payload",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 14,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-direct-1");
    expect(replySpy).not.toHaveBeenCalled();
  });

  it("dedupes repeated callback clicks by sender/message/data", async () => {
    onSpy.mockReset();
    replySpy.mockReset();

    createTelegramBot({
      token: "tok",
      config: {
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
            callback: { enabled: true, dedupeWindowMs: 15_000 },
          },
        },
      },
    });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    const baseCallback = {
      callbackQuery: {
        id: "cbq-dedupe-1",
        data: "cmd:option_a",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 15,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    };

    await callbackHandler(baseCallback);
    await callbackHandler({
      ...baseCallback,
      callbackQuery: { ...baseCallback.callbackQuery, id: "cbq-dedupe-2" },
    });

    expect(answerCallbackQuerySpy).toHaveBeenCalledTimes(2);
    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("does not dedupe built-in UI transition callbacks", async () => {
    onSpy.mockReset();
    editMessageTextSpy.mockReset();

    createTelegramBot({
      token: "tok",
      config: {
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
            callback: { enabled: true, dedupeWindowMs: 15_000 },
          },
        },
      },
    });

    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    const base = {
      callbackQuery: {
        id: "cbq-ui-1",
        data: "mdl_back",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 21,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    };

    await callbackHandler(base);
    await callbackHandler({
      ...base,
      callbackQuery: { ...base.callbackQuery, id: "cbq-ui-2" },
    });

    expect(editMessageTextSpy).toHaveBeenCalledTimes(2);
  });

  it("ignores disabled callback sentinel payloads", async () => {
    onSpy.mockReset();
    replySpy.mockReset();

    createTelegramBot({
      token: "tok",
      config: {
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
            callback: {
              enabled: true,
              forwardUnhandled: true,
            },
          },
        },
      },
    });

    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await callbackHandler({
      callbackQuery: {
        id: "cbq-disabled-1",
        data: "ocb:clicked:abc123",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 17,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-disabled-1");
    expect(replySpy).not.toHaveBeenCalled();
  });

  it("locks non built-in callback choices by hiding unclicked options", async () => {
    onSpy.mockReset();
    editMessageReplyMarkupSpy.mockReset();

    createTelegramBot({
      token: "tok",
      config: {
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
            callback: {
              enabled: true,
              forwardUnhandled: false,
              buttonStateMode: "mark-clicked",
            },
          },
        },
      },
    });

    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await callbackHandler({
      callbackQuery: {
        id: "cbq-lock-1",
        data: "choice:b",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 19,
          reply_markup: {
            inline_keyboard: [
              [
                { text: "A", callback_data: "choice:a" },
                { text: "B", callback_data: "choice:b" },
              ],
            ],
          },
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(editMessageReplyMarkupSpy).toHaveBeenCalledTimes(1);
    const [, , params] = editMessageReplyMarkupSpy.mock.calls[0] ?? [];
    // mark-clicked: prefixes clicked button with ✅ and keeps callback_data tappable
    expect(params).toEqual(
      expect.objectContaining({
        reply_markup: {
          inline_keyboard: [
            [
              expect.objectContaining({
                text: "✅ B",
                callback_data: "choice:b",
              }),
            ],
          ],
        },
      }),
    );
  });

  it("replaces callback_data with sentinel in disable-clicked mode", async () => {
    onSpy.mockReset();
    editMessageReplyMarkupSpy.mockReset();

    createTelegramBot({
      token: "tok",
      config: {
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
            callback: {
              enabled: true,
              forwardUnhandled: false,
              buttonStateMode: "disable-clicked",
            },
          },
        },
      },
    });

    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await callbackHandler({
      callbackQuery: {
        id: "cbq-disable-1",
        data: "choice:a",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 20,
          reply_markup: {
            inline_keyboard: [
              [
                { text: "A", callback_data: "choice:a" },
                { text: "B", callback_data: "choice:b" },
              ],
            ],
          },
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(editMessageReplyMarkupSpy).toHaveBeenCalledTimes(1);
    const [, , params2] = editMessageReplyMarkupSpy.mock.calls[0] ?? [];
    // disable-clicked: clicked button gets ✅ prefix and callback_data sentinel (noop)
    expect(params2).toEqual(
      expect.objectContaining({
        reply_markup: {
          inline_keyboard: [
            [
              expect.objectContaining({
                text: "✅ A",
                callback_data: expect.stringContaining("ocb:clicked"),
              }),
            ],
          ],
        },
      }),
    );
  });

  it("blocks callback_query when inline buttons are allowlist-only and sender not authorized", async () => {
    onSpy.mockReset();
    replySpy.mockReset();

    createTelegramBot({
      token: "tok",
      config: {
        channels: {
          telegram: {
            dmPolicy: "pairing",
            capabilities: { inlineButtons: "allowlist" },
            allowFrom: [],
          },
        },
      },
    });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-2",
        data: "cmd:option_b",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 11,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-2");
  });

  it("edits commands list for pagination callbacks", async () => {
    onSpy.mockReset();
    listSkillCommandsForAgents.mockReset();

    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-3",
        data: "commands_page_2:main",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 12,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(listSkillCommandsForAgents).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      agentIds: ["main"],
    });
    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
    const [chatId, messageId, text, params] = editMessageTextSpy.mock.calls[0] ?? [];
    expect(chatId).toBe(1234);
    expect(messageId).toBe(12);
    expect(String(text)).toContain("ℹ️ Commands");
    expect(params).toEqual(
      expect.objectContaining({
        reply_markup: expect.any(Object),
      }),
    );
  });

  it("skips checkmark state edit for UI transition callbacks", async () => {
    onSpy.mockReset();
    editMessageReplyMarkupSpy.mockReset();
    editMessageTextSpy.mockReset();

    createTelegramBot({
      token: "tok",
      config: {
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
            callback: {
              enabled: true,
              buttonStateMode: "mark-clicked",
            },
          },
        },
      },
    });

    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await callbackHandler({
      callbackQuery: {
        id: "cbq-ui-transition-1",
        data: "commands_page_2:main",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 18,
          reply_markup: {
            inline_keyboard: [[{ text: "Next", callback_data: "commands_page_2:main" }]],
          },
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
  });

  it("blocks pagination callbacks when allowlist rejects sender", async () => {
    onSpy.mockReset();
    editMessageTextSpy.mockReset();

    createTelegramBot({
      token: "tok",
      config: {
        channels: {
          telegram: {
            dmPolicy: "pairing",
            capabilities: { inlineButtons: "allowlist" },
            allowFrom: [],
          },
        },
      },
    });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-4",
        data: "commands_page_2",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 13,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(editMessageTextSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-4");
  });

  it("includes sender identity in group envelope headers", async () => {
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
    expectInboundContextContract(payload);
    const expectedTimestamp = formatEnvelopeTimestamp(new Date("2025-01-09T00:00:00Z"));
    const timestampPattern = escapeRegExp(expectedTimestamp);
    expect(payload.Body).toMatch(
      new RegExp(`^\\[Telegram Ops id:42 (\\+\\d+[smhd] )?${timestampPattern}\\]`),
    );
    expect(payload.SenderName).toBe("Ada Lovelace");
    expect(payload.SenderId).toBe("99");
    expect(payload.SenderUsername).toBe("ada");
  });

  it("uses quote text when a Telegram partial reply is received", async () => {
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
        quote: {
          text: "summarize this",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.Body).toContain("[Quoting Ada id:9001]");
    expect(payload.Body).toContain('"summarize this"');
    expect(payload.ReplyToId).toBe("9001");
    expect(payload.ReplyToBody).toBe("summarize this");
    expect(payload.ReplyToSender).toBe("Ada");
  });

  it("handles quote-only replies without reply metadata", async () => {
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
        quote: {
          text: "summarize this",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.Body).toContain("[Quoting unknown sender]");
    expect(payload.Body).toContain('"summarize this"');
    expect(payload.ReplyToId).toBeUndefined();
    expect(payload.ReplyToBody).toBe("summarize this");
    expect(payload.ReplyToSender).toBe("unknown sender");
  });

  it("uses external_reply quote text for partial replies", async () => {
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
        external_reply: {
          message_id: 9002,
          text: "Can you summarize this?",
          from: { first_name: "Ada" },
          quote: {
            text: "summarize this",
          },
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.Body).toContain("[Quoting Ada id:9002]");
    expect(payload.Body).toContain('"summarize this"');
    expect(payload.ReplyToId).toBe("9002");
    expect(payload.ReplyToBody).toBe("summarize this");
    expect(payload.ReplyToSender).toBe("Ada");
  });

  it("accepts group replies to the bot without explicit mention when requireMention is enabled", async () => {
    onSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: { groups: { "*": { requireMention: true } } },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 456, type: "group", title: "Ops Chat" },
        text: "following up",
        date: 1736380800,
        reply_to_message: {
          message_id: 42,
          text: "original reply",
          from: { id: 999, first_name: "OpenClaw" },
        },
      },
      me: { id: 999, username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.WasMentioned).toBe(true);
  });

  it("inherits group allowlist + requireMention in topics", async () => {
    onSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groups: {
            "-1001234567890": {
              requireMention: false,
              allowFrom: ["123456789"],
              topics: {
                "99": {},
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
        from: { id: 123456789, username: "testuser" },
        text: "hello",
        date: 1736380800,
        message_thread_id: 99,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("prefers topic allowFrom over group allowFrom", async () => {
    onSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groups: {
            "-1001234567890": {
              allowFrom: ["123456789"],
              topics: {
                "99": { allowFrom: ["999999999"] },
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
        from: { id: 123456789, username: "testuser" },
        text: "hello",
        date: 1736380800,
        message_thread_id: 99,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(0);
  });

  it("allows group messages for per-group groupPolicy open override (global groupPolicy allowlist)", async () => {
    onSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groups: {
            "-100123456789": {
              groupPolicy: "open",
              requireMention: false,
            },
          },
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValueOnce(["123456789"]);

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

  it("blocks control commands from unauthorized senders in per-group open groups", async () => {
    onSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groups: {
            "-100123456789": {
              groupPolicy: "open",
              requireMention: false,
            },
          },
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValueOnce(["123456789"]);

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 999999, username: "random" },
        text: "/status",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).not.toHaveBeenCalled();
  });
  it("sets command target session key for dm topic commands", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    commandSpy.mockReset();
    replySpy.mockReset();
    replySpy.mockResolvedValue({ text: "response" });

    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "pairing",
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValueOnce(["12345"]);

    createTelegramBot({ token: "tok" });
    const handler = commandSpy.mock.calls.find((call) => call[0] === "status")?.[1] as
      | ((ctx: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!handler) {
      throw new Error("status command handler missing");
    }

    await handler({
      message: {
        chat: { id: 12345, type: "private" },
        from: { id: 12345, username: "testuser" },
        text: "/status",
        date: 1736380800,
        message_id: 42,
        message_thread_id: 99,
      },
      match: "",
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.CommandTargetSessionKey).toBe("agent:main:main:thread:99");
  });

  it("allows native DM commands for paired users", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    commandSpy.mockReset();
    replySpy.mockReset();
    replySpy.mockResolvedValue({ text: "response" });

    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "pairing",
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValueOnce(["12345"]);

    createTelegramBot({ token: "tok" });
    const handler = commandSpy.mock.calls.find((call) => call[0] === "status")?.[1] as
      | ((ctx: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!handler) {
      throw new Error("status command handler missing");
    }

    await handler({
      message: {
        chat: { id: 12345, type: "private" },
        from: { id: 12345, username: "testuser" },
        text: "/status",
        date: 1736380800,
        message_id: 42,
      },
      match: "",
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(
      sendMessageSpy.mock.calls.some(
        (call) => call[1] === "You are not authorized to use this command.",
      ),
    ).toBe(false);
  });

  it("blocks native DM commands for unpaired users", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    commandSpy.mockReset();
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "pairing",
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValueOnce([]);

    createTelegramBot({ token: "tok" });
    const handler = commandSpy.mock.calls.find((call) => call[0] === "status")?.[1] as
      | ((ctx: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!handler) {
      throw new Error("status command handler missing");
    }

    await handler({
      message: {
        chat: { id: 12345, type: "private" },
        from: { id: 12345, username: "testuser" },
        text: "/status",
        date: 1736380800,
        message_id: 42,
      },
      match: "",
    });

    expect(replySpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledWith(
      12345,
      "You are not authorized to use this command.",
    );
  });

  it("registers message_reaction handler", () => {
    onSpy.mockReset();
    createTelegramBot({ token: "tok" });
    const reactionHandler = onSpy.mock.calls.find((call) => call[0] === "message_reaction");
    expect(reactionHandler).toBeDefined();
  });

  it("enqueues system event for reaction", async () => {
    onSpy.mockReset();
    enqueueSystemEventSpy.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 500 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada", username: "ada_bot" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "👍" }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      "Telegram reaction added: 👍 by Ada (@ada_bot) on msg 42",
      expect.objectContaining({
        contextKey: expect.stringContaining("telegram:reaction:add:1234:42:9"),
      }),
    );
  });

  it("skips reaction when reactionNotifications is off", async () => {
    onSpy.mockReset();
    enqueueSystemEventSpy.mockReset();
    wasSentByBot.mockReturnValue(true);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "off" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 501 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "👍" }],
      },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("defaults reactionNotifications to own", async () => {
    onSpy.mockReset();
    enqueueSystemEventSpy.mockReset();
    wasSentByBot.mockReturnValue(true);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 502 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 43,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "👍" }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
  });

  it("allows reaction in all mode regardless of message sender", async () => {
    onSpy.mockReset();
    enqueueSystemEventSpy.mockReset();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 503 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 99,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "🎉" }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      "Telegram reaction added: 🎉 by Ada on msg 99",
      expect.any(Object),
    );
  });

  it("skips reaction in own mode when message is not sent by bot", async () => {
    onSpy.mockReset();
    enqueueSystemEventSpy.mockReset();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "own" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 503 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 99,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "🎉" }],
      },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("allows reaction in own mode when message is sent by bot", async () => {
    onSpy.mockReset();
    enqueueSystemEventSpy.mockReset();
    wasSentByBot.mockReturnValue(true);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "own" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 503 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 99,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "🎉" }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
  });

  it("skips reaction from bot users", async () => {
    onSpy.mockReset();
    enqueueSystemEventSpy.mockReset();
    wasSentByBot.mockReturnValue(true);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 503 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 99,
        user: { id: 9, first_name: "Bot", is_bot: true },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "🎉" }],
      },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("skips reaction removal (only processes added reactions)", async () => {
    onSpy.mockReset();
    enqueueSystemEventSpy.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [{ type: "emoji", emoji: "👍" }],
        new_reaction: [],
      },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("enqueues one event per added emoji reaction", async () => {
    onSpy.mockReset();
    enqueueSystemEventSpy.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 505 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [{ type: "emoji", emoji: "👍" }],
        new_reaction: [
          { type: "emoji", emoji: "👍" },
          { type: "emoji", emoji: "🔥" },
          { type: "emoji", emoji: "🎉" },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(2);
    expect(enqueueSystemEventSpy.mock.calls.map((call) => call[0])).toEqual([
      "Telegram reaction added: 🔥 by Ada on msg 42",
      "Telegram reaction added: 🎉 by Ada on msg 42",
    ]);
  });

  it("routes forum group reactions to the general topic (thread id not available on reactions)", async () => {
    onSpy.mockReset();
    enqueueSystemEventSpy.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    // MessageReactionUpdated does not include message_thread_id in the Bot API,
    // so forum reactions always route to the general topic (1).
    await handler({
      update: { update_id: 505 },
      messageReaction: {
        chat: { id: 5678, type: "supergroup", is_forum: true },
        message_id: 100,
        user: { id: 10, first_name: "Bob", username: "bob_user" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "🔥" }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      "Telegram reaction added: 🔥 by Bob (@bob_user) on msg 100",
      expect.objectContaining({
        sessionKey: expect.stringContaining("telegram:group:5678:topic:1"),
        contextKey: expect.stringContaining("telegram:reaction:add:5678:100:10"),
      }),
    );
  });

  it("uses correct session key for forum group reactions in general topic", async () => {
    onSpy.mockReset();
    enqueueSystemEventSpy.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 506 },
      messageReaction: {
        chat: { id: 5678, type: "supergroup", is_forum: true },
        message_id: 101,
        // No message_thread_id - should default to general topic (1)
        user: { id: 10, first_name: "Bob" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "👀" }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      "Telegram reaction added: 👀 by Bob on msg 101",
      expect.objectContaining({
        sessionKey: expect.stringContaining("telegram:group:5678:topic:1"),
        contextKey: expect.stringContaining("telegram:reaction:add:5678:101:10"),
      }),
    );
  });

  it("uses correct session key for regular group reactions without topic", async () => {
    onSpy.mockReset();
    enqueueSystemEventSpy.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 507 },
      messageReaction: {
        chat: { id: 9999, type: "group" },
        message_id: 200,
        user: { id: 11, first_name: "Charlie" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "❤️" }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      "Telegram reaction added: ❤️ by Charlie on msg 200",
      expect.objectContaining({
        sessionKey: expect.stringContaining("telegram:group:9999"),
        contextKey: expect.stringContaining("telegram:reaction:add:9999:200:11"),
      }),
    );
    // Verify session key does NOT contain :topic:
    const eventOptions = enqueueSystemEventSpy.mock.calls[0]?.[1] as {
      sessionKey?: string;
    };
    const sessionKey = eventOptions.sessionKey ?? "";
    expect(sessionKey).not.toContain(":topic:");
  });

  it("calls answerCallbackQuery exactly once with ackText when tapIntercept is enabled", async () => {
    onSpy.mockReset();
    answerCallbackQuerySpy.mockReset();
    middlewareUseSpy.mockReset();
    replySpy.mockReset();

    createTelegramBot({
      token: "tok",
      config: {
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
            callback: {
              enabled: true,
              tapIntercept: true,
              ackText: "Got it!",
              forwardUnhandled: true,
            },
          },
        },
      },
    });

    // The tapIntercept middleware is registered via bot.use().
    // Extract the last middleware registered (the tap intercept + logging middleware).
    const middlewareFn = middlewareUseSpy.mock.calls.at(-1)?.[0] as
      | ((ctx: Record<string, unknown>, next: () => Promise<void>) => Promise<void>)
      | undefined;
    expect(middlewareFn).toBeDefined();

    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    const ctx = {
      callbackQuery: {
        id: "cbq-tap-1",
        data: "cmd:option_a",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 30,
        },
      },
      update: {
        callback_query: {
          id: "cbq-tap-1",
          data: "cmd:option_a",
          from: { id: 9, first_name: "Ada", username: "ada_bot" },
          message: {
            chat: { id: 1234, type: "private" },
            date: 1736380800,
            message_id: 30,
          },
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    };

    // Run the middleware (which should call answerCallbackQuery with ackText)
    await middlewareFn!(ctx, async () => {});

    // Run the handler (which should skip answerCallbackQuery since tapIntercept is on)
    await callbackHandler(ctx);

    // answerCallbackQuery should be called exactly once — by the middleware
    expect(answerCallbackQuerySpy).toHaveBeenCalledTimes(1);
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-tap-1", {
      text: "Got it!",
      show_alert: undefined,
    });
  });

  it("acks disabled sentinel button without forwarding to processMessage", async () => {
    onSpy.mockReset();
    replySpy.mockReset();
    answerCallbackQuerySpy.mockReset();
    enqueueSystemEventSpy.mockReset();

    createTelegramBot({
      token: "tok",
      config: {
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
            callback: {
              enabled: true,
              forwardUnhandled: true,
              ackText: "Custom ack",
            },
          },
        },
      },
    });

    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await callbackHandler({
      callbackQuery: {
        id: "cbq-sentinel-1",
        data: "ocb:clicked:xyz789",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 31,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    // Should get a plain ack (no ackText/ackAlert) since it's a disabled button
    expect(answerCallbackQuerySpy).toHaveBeenCalledTimes(1);
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-sentinel-1");
    // Should NOT forward to processMessage or enqueue system events
    expect(replySpy).not.toHaveBeenCalled();
    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("answers sentinel callback exactly once when tapIntercept is enabled", async () => {
    onSpy.mockReset();
    answerCallbackQuerySpy.mockReset();
    middlewareUseSpy.mockReset();

    createTelegramBot({
      token: "tok",
      config: {
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
            callback: {
              enabled: true,
              tapIntercept: true,
              forwardUnhandled: true,
              ackText: "Got it!",
            },
          },
        },
      },
    });

    const middlewareFn = middlewareUseSpy.mock.calls.at(-1)?.[0] as
      | ((ctx: Record<string, unknown>, next: () => Promise<void>) => Promise<void>)
      | undefined;
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    const ctx = {
      callbackQuery: {
        id: "cbq-sentinel-tap-1",
        data: "ocb:clicked:xyz789",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 32,
        },
      },
      update: {
        callback_query: {
          id: "cbq-sentinel-tap-1",
          data: "ocb:clicked:xyz789",
          from: { id: 9, first_name: "Ada", username: "ada_bot" },
          message: {
            chat: { id: 1234, type: "private" },
            date: 1736380800,
            message_id: 32,
          },
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    };

    await middlewareFn!(ctx, async () => {});
    await callbackHandler(ctx);

    expect(answerCallbackQuerySpy).toHaveBeenCalledTimes(1);
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-sentinel-tap-1", undefined);
  });
});
