import { describe, expect, it, vi } from "vitest";
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

describe("registerTelegramNativeCommands (plugin auth)", () => {
  function registerPluginCommandHandler(params: {
    cfg: OpenClawConfig;
    allowFrom?: string[];
    groupAllowFrom?: string[];
  }): {
    handler: ((ctx: unknown) => Promise<void>) | undefined;
    sendMessage: ReturnType<typeof vi.fn>;
  } {
    getPluginCommandSpecs.mockClear();
    matchPluginCommand.mockClear();
    executePluginCommand.mockClear();
    deliverReplies.mockClear();

    const command = {
      name: "plugin",
      description: "Plugin command",
      requireAuth: true,
      handler: vi.fn(),
    } as const;

    getPluginCommandSpecs.mockReturnValue([{ name: "plugin", description: "Plugin command" }]);
    matchPluginCommand.mockReturnValue({ command, args: undefined });
    executePluginCommand.mockResolvedValue({ text: "ok" });

    const handlers: Record<string, (ctx: unknown) => Promise<void>> = {};
    const sendMessage = vi.fn();
    const bot = {
      api: {
        setMyCommands: vi.fn().mockResolvedValue(undefined),
        sendMessage,
      },
      command: (name: string, handler: (ctx: unknown) => Promise<void>) => {
        handlers[name] = handler;
      },
    } as const;

    registerTelegramNativeCommands({
      bot: bot as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
      cfg: params.cfg,
      runtime: {} as unknown as RuntimeEnv,
      accountId: "default",
      telegramCfg: {} as TelegramAccountConfig,
      allowFrom: params.allowFrom ?? [],
      groupAllowFrom: params.groupAllowFrom ?? [],
      replyToMode: "off",
      textLimit: 4000,
      useAccessGroups: false,
      nativeEnabled: false,
      nativeSkillsEnabled: false,
      nativeDisabledExplicit: false,
      resolveGroupPolicy: () =>
        ({
          allowlistEnabled: false,
          allowed: true,
        }) as ChannelGroupPolicy,
      resolveTelegramGroupConfig: () => ({
        groupConfig: undefined,
        topicConfig: undefined,
      }),
      shouldSkipUpdate: () => false,
      opts: { token: "token" },
    });

    return { handler: handlers.plugin, sendMessage };
  }

  it("does not register plugin commands in menu when native=false but keeps handlers available", () => {
    const specs = Array.from({ length: 101 }, (_, i) => ({
      name: `cmd_${i}`,
      description: `Command ${i}`,
    }));
    getPluginCommandSpecs.mockReturnValue(specs);

    const handlers: Record<string, (ctx: unknown) => Promise<void>> = {};
    const setMyCommands = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    const bot = {
      api: {
        setMyCommands,
        sendMessage: vi.fn(),
      },
      command: (name: string, handler: (ctx: unknown) => Promise<void>) => {
        handlers[name] = handler;
      },
    } as const;

    registerTelegramNativeCommands({
      bot: bot as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
      cfg: {} as OpenClawConfig,
      runtime: { log } as unknown as RuntimeEnv,
      accountId: "default",
      telegramCfg: {} as TelegramAccountConfig,
      allowFrom: [],
      groupAllowFrom: [],
      replyToMode: "off",
      textLimit: 4000,
      useAccessGroups: false,
      nativeEnabled: false,
      nativeSkillsEnabled: false,
      nativeDisabledExplicit: false,
      resolveGroupPolicy: () =>
        ({
          allowlistEnabled: false,
          allowed: true,
        }) as ChannelGroupPolicy,
      resolveTelegramGroupConfig: () => ({
        groupConfig: undefined,
        topicConfig: undefined,
      }),
      shouldSkipUpdate: () => false,
      opts: { token: "token" },
    });

    expect(setMyCommands).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("registering first 100"));
    expect(Object.keys(handlers)).toHaveLength(101);
  });

  it("allows requireAuth:false plugin command even when sender is unauthorized", async () => {
    const command = {
      name: "plugin",
      description: "Plugin command",
      requireAuth: false,
      handler: vi.fn(),
    } as const;

    getPluginCommandSpecs.mockReturnValue([{ name: "plugin", description: "Plugin command" }]);
    matchPluginCommand.mockReturnValue({ command, args: undefined });
    executePluginCommand.mockResolvedValue({ text: "ok" });

    const handlers: Record<string, (ctx: unknown) => Promise<void>> = {};
    const bot = {
      api: {
        setMyCommands: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn(),
      },
      command: (name: string, handler: (ctx: unknown) => Promise<void>) => {
        handlers[name] = handler;
      },
    } as const;

    const cfg = {} as OpenClawConfig;
    const telegramCfg = {} as TelegramAccountConfig;
    const resolveGroupPolicy = () =>
      ({
        allowlistEnabled: false,
        allowed: true,
      }) as ChannelGroupPolicy;

    registerTelegramNativeCommands({
      bot: bot as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
      cfg,
      runtime: {} as unknown as RuntimeEnv,
      accountId: "default",
      telegramCfg,
      allowFrom: ["999"],
      groupAllowFrom: [],
      replyToMode: "off",
      textLimit: 4000,
      useAccessGroups: false,
      nativeEnabled: false,
      nativeSkillsEnabled: false,
      nativeDisabledExplicit: false,
      resolveGroupPolicy,
      resolveTelegramGroupConfig: () => ({
        groupConfig: undefined,
        topicConfig: undefined,
      }),
      shouldSkipUpdate: () => false,
      opts: { token: "token" },
    });

    const ctx = {
      message: {
        chat: { id: 123, type: "private" },
        from: { id: 111, username: "nope" },
        message_id: 10,
        date: 123456,
      },
      match: "",
    };

    await handlers.plugin?.(ctx);

    expect(matchPluginCommand).toHaveBeenCalled();
    expect(executePluginCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        isAuthorizedSender: false,
      }),
    );
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [{ text: "ok" }],
      }),
    );
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it("allows native group plugin commands via commands.allowFrom global override", async () => {
    const { handler, sendMessage } = registerPluginCommandHandler({
      cfg: {
        commands: {
          allowFrom: {
            "*": ["111"],
          },
        },
      } as OpenClawConfig,
      allowFrom: ["999"],
    });

    await handler?.({
      message: {
        chat: { id: -100123, type: "supergroup" },
        from: { id: 111, username: "allowed" },
        message_id: 10,
        date: 123456,
      },
      match: "",
    });

    expect(executePluginCommand).toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalledWith(
      -100123,
      "You are not authorized to use this command.",
    );
  });

  it("allows native group plugin commands when commands.allowFrom uses telegram prefix", async () => {
    const { handler, sendMessage } = registerPluginCommandHandler({
      cfg: {
        commands: {
          allowFrom: {
            "*": ["telegram:111"],
          },
        },
      } as OpenClawConfig,
      allowFrom: ["999"],
    });

    await handler?.({
      message: {
        chat: { id: -100124, type: "supergroup" },
        from: { id: 111, username: "allowed" },
        message_id: 14,
        date: 123460,
      },
      match: "",
    });

    expect(executePluginCommand).toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalledWith(
      -100124,
      "You are not authorized to use this command.",
    );
  });

  it("allows native group plugin commands via commands.allowFrom provider-specific override", async () => {
    const { handler, sendMessage } = registerPluginCommandHandler({
      cfg: {
        commands: {
          allowFrom: {
            "*": ["global-user"],
            telegram: ["111"],
          },
        },
      } as OpenClawConfig,
      allowFrom: ["999"],
    });

    await handler?.({
      message: {
        chat: { id: -100456, type: "supergroup" },
        from: { id: 111, username: "allowed" },
        message_id: 11,
        date: 123457,
      },
      match: "",
    });

    expect(executePluginCommand).toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalledWith(
      -100456,
      "You are not authorized to use this command.",
    );
  });

  it("keeps native fallback authorization when commands.allowFrom is not configured", async () => {
    const { handler, sendMessage } = registerPluginCommandHandler({
      cfg: {} as OpenClawConfig,
      allowFrom: ["999"],
    });

    await handler?.({
      message: {
        chat: { id: -100789, type: "supergroup" },
        from: { id: 111, username: "denied" },
        message_id: 12,
        date: 123458,
      },
      match: "",
    });

    expect(executePluginCommand).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      -100789,
      "You are not authorized to use this command.",
    );
  });

  it("prefers provider-specific commands.allowFrom over global for native auth", async () => {
    const { handler, sendMessage } = registerPluginCommandHandler({
      cfg: {
        commands: {
          allowFrom: {
            "*": ["111"],
            telegram: ["222"],
          },
        },
      } as OpenClawConfig,
      allowFrom: ["999"],
    });

    await handler?.({
      message: {
        chat: { id: -100987, type: "supergroup" },
        from: { id: 111, username: "global-only" },
        message_id: 13,
        date: 123459,
      },
      match: "",
    });

    expect(executePluginCommand).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      -100987,
      "You are not authorized to use this command.",
    );
  });
});
