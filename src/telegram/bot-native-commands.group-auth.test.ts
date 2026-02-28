import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ChannelGroupPolicy } from "../config/group-policy.js";
import type { TelegramAccountConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";

const getPluginCommandSpecs = vi.hoisted(() => vi.fn());
const matchPluginCommand = vi.hoisted(() => vi.fn());
const executePluginCommand = vi.hoisted(() => vi.fn());

vi.mock("../plugins/commands.js", () => ({
  getPluginCommandSpecs,
  matchPluginCommand,
  executePluginCommand,
}));

const deliverReplies = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./bot/delivery.js", () => ({ deliverReplies }));

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn(async () => []),
}));

describe("registerTelegramNativeCommands (group command authorization)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPluginCommandSpecs.mockReturnValue([]);
    matchPluginCommand.mockReturnValue(null);
    executePluginCommand.mockResolvedValue({ text: "ok" });
    deliverReplies.mockResolvedValue(undefined);
  });

  it("blocks unauthorized users in groups even if they are in DM allowFrom", async () => {
    // This is the critical regression test: users in DM allowFrom should NOT be
    // authorized in groups if they're not in group allowFrom
    //
    // Setup: DM allowFrom has user 111, group allowFrom has user 222
    // When a group command is sent by user 111 (in DM allowFrom only), it should be BLOCKED

    const handlers: Record<string, (ctx: unknown) => Promise<void>> = {};
    const bot = {
      api: {
        setMyCommands: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      },
      command: (name: string, handler: (ctx: unknown) => Promise<void>) => {
        handlers[name] = handler;
      },
    } as const;

    const cfg = {} as OpenClawConfig;
    const telegramCfg = {
      groups: {
        "123": {
          allowFrom: ["222"], // Only user 222 is allowed in GROUP
          enabled: true,
          requireMention: false,
        },
      },
    } as TelegramAccountConfig;

    const resolveGroupPolicy = () =>
      ({
        allowlistEnabled: false,
        allowed: true,
      }) as ChannelGroupPolicy;

    const resolveTelegramGroupConfig = (chatId: string | number, _messageThreadId?: number) => {
      const groupConfig = telegramCfg.groups?.[String(chatId)];
      return {
        groupConfig: groupConfig
          ? {
              allowFrom: groupConfig.allowFrom,
              enabled: groupConfig.enabled,
              requireMention: false,
            }
          : undefined,
        topicConfig: undefined,
      };
    };

    registerTelegramNativeCommands({
      bot: bot as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
      cfg,
      runtime: {} as unknown as RuntimeEnv,
      accountId: "default",
      telegramCfg,
      allowFrom: ["111"], // User 111 is allowed in DM
      groupAllowFrom: ["222"], // User 222 is allowed in group
      replyToMode: "off",
      textLimit: 4000,
      useAccessGroups: true,
      nativeEnabled: true,
      nativeSkillsEnabled: false,
      nativeDisabledExplicit: false,
      resolveGroupPolicy,
      resolveTelegramGroupConfig,
      shouldSkipUpdate: () => false,
      opts: { token: "token" },
    });

    // Simulate a group command from user 111 (who is in DM allowFrom but NOT in group allowFrom)
    const ctx = {
      message: {
        chat: { id: 123, type: "supergroup" },
        from: { id: 111, username: "dm_user" }, // User 111 - in DM allowFrom only
        message_id: 10,
        date: 123456,
        text: "/help",
      },
      match: "help",
      me: { id: 999, username: "testbot" },
    };

    await handlers.help?.(ctx);

    // User 111 should NOT be authorized in the group (they're not in group allowFrom)
    // The bot should send "You are not authorized" message
    // This is the key regression test: BEFORE the fix, user 111 would have been authorized
    // because the code was using DM allowFrom for groups
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      123,
      "You are not authorized to use this command.",
    );
  });

  it("allows authorized users in group allowFrom", async () => {
    // Users in group allowFrom should be authorized for group commands

    const handlers: Record<string, (ctx: unknown) => Promise<void>> = {};
    const bot = {
      api: {
        setMyCommands: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      },
      command: (name: string, handler: (ctx: unknown) => Promise<void>) => {
        handlers[name] = handler;
      },
    } as const;

    const cfg = {} as OpenClawConfig;
    const telegramCfg = {
      groups: {
        "123": {
          allowFrom: ["222"], // User 222 is allowed in GROUP
          enabled: true,
          requireMention: false,
        },
      },
    } as TelegramAccountConfig;

    const resolveGroupPolicy = () =>
      ({
        allowlistEnabled: false,
        allowed: true,
      }) as ChannelGroupPolicy;

    const resolveTelegramGroupConfig = (chatId: string | number, _messageThreadId?: number) => {
      const groupConfig = telegramCfg.groups?.[String(chatId)];
      return {
        groupConfig: groupConfig
          ? {
              allowFrom: groupConfig.allowFrom,
              enabled: groupConfig.enabled,
              requireMention: false,
            }
          : undefined,
        topicConfig: undefined,
      };
    };

    registerTelegramNativeCommands({
      bot: bot as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
      cfg,
      runtime: {} as unknown as RuntimeEnv,
      accountId: "default",
      telegramCfg,
      allowFrom: ["111"], // User 111 is allowed in DM only
      groupAllowFrom: ["222"], // User 222 is allowed in group
      replyToMode: "off",
      textLimit: 4000,
      useAccessGroups: true,
      nativeEnabled: true,
      nativeSkillsEnabled: false,
      nativeDisabledExplicit: false,
      resolveGroupPolicy,
      resolveTelegramGroupConfig,
      shouldSkipUpdate: () => false,
      opts: { token: "token" },
    });

    // Simulate a group command from user 222 (who is in group allowFrom)
    const ctx = {
      message: {
        chat: { id: 123, type: "supergroup" },
        from: { id: 222, username: "group_user" }, // User 222 - in group allowFrom
        message_id: 10,
        date: 123456,
        text: "/help",
      },
      match: "help",
      me: { id: 999, username: "testbot" },
    };

    await handlers.help?.(ctx);

    // User 222 should be authorized in the group (they're in group allowFrom)
    // The bot should NOT send unauthorized message - it should process the command
    // Instead of checking sendMessage not called, check that the command was processed
    // (deliverReplies was called means command was authorized and executed)
    expect(deliverReplies).toHaveBeenCalled();
    expect(bot.api.sendMessage).not.toHaveBeenCalledWith(
      123,
      "You are not authorized to use this command.",
    );
  });
});
