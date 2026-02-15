import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { TelegramAccountConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { STATE_DIR } from "../config/paths.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";

const { listSkillCommandsForAgents } = vi.hoisted(() => ({
  listSkillCommandsForAgents: vi.fn(() => []),
}));
const pluginCommandMocks = vi.hoisted(() => ({
  getPluginCommandSpecs: vi.fn(() => []),
  matchPluginCommand: vi.fn(() => null),
  executePluginCommand: vi.fn(async () => ({ text: "ok" })),
}));
const deliveryMocks = vi.hoisted(() => ({
  deliverReplies: vi.fn(async () => ({ delivered: true })),
}));

vi.mock("../auto-reply/skill-commands.js", () => ({
  listSkillCommandsForAgents,
}));
vi.mock("../plugins/commands.js", () => ({
  getPluginCommandSpecs: pluginCommandMocks.getPluginCommandSpecs,
  matchPluginCommand: pluginCommandMocks.matchPluginCommand,
  executePluginCommand: pluginCommandMocks.executePluginCommand,
}));
vi.mock("./bot/delivery.js", () => ({
  deliverReplies: deliveryMocks.deliverReplies,
}));

describe("registerTelegramNativeCommands", () => {
  beforeEach(() => {
    listSkillCommandsForAgents.mockReset();
    pluginCommandMocks.getPluginCommandSpecs.mockReset();
    pluginCommandMocks.getPluginCommandSpecs.mockReturnValue([]);
    pluginCommandMocks.matchPluginCommand.mockReset();
    pluginCommandMocks.matchPluginCommand.mockReturnValue(null);
    pluginCommandMocks.executePluginCommand.mockReset();
    pluginCommandMocks.executePluginCommand.mockResolvedValue({ text: "ok" });
    deliveryMocks.deliverReplies.mockReset();
    deliveryMocks.deliverReplies.mockResolvedValue({ delivered: true });
  });

  const buildParams = (cfg: OpenClawConfig, accountId = "default") => ({
    bot: {
      api: {
        setMyCommands: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
      command: vi.fn(),
    } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
    cfg,
    runtime: {} as RuntimeEnv,
    accountId,
    telegramCfg: {} as TelegramAccountConfig,
    allowFrom: [],
    groupAllowFrom: [],
    replyToMode: "off" as const,
    textLimit: 4096,
    useAccessGroups: false,
    nativeEnabled: true,
    nativeSkillsEnabled: true,
    nativeDisabledExplicit: false,
    resolveGroupPolicy: () => ({ allowlistEnabled: false, allowed: true }),
    resolveTelegramGroupConfig: () => ({
      groupConfig: undefined,
      topicConfig: undefined,
    }),
    shouldSkipUpdate: () => false,
    opts: { token: "token" },
  });

  it("scopes skill commands when account binding exists", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true }, { id: "butler" }],
      },
      bindings: [
        {
          agentId: "butler",
          match: { channel: "telegram", accountId: "bot-a" },
        },
      ],
    };

    registerTelegramNativeCommands(buildParams(cfg, "bot-a"));

    expect(listSkillCommandsForAgents).toHaveBeenCalledWith({
      cfg,
      agentIds: ["butler"],
    });
  });

  it("scopes skill commands to default agent without a matching binding (#15599)", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true }, { id: "butler" }],
      },
    };

    registerTelegramNativeCommands(buildParams(cfg, "bot-a"));

    expect(listSkillCommandsForAgents).toHaveBeenCalledWith({
      cfg,
      agentIds: ["main"],
    });
  });

  it("truncates Telegram command registration to 100 commands", () => {
    const cfg: OpenClawConfig = {
      commands: { native: false },
    };
    const customCommands = Array.from({ length: 120 }, (_, index) => ({
      command: `cmd_${index}`,
      description: `Command ${index}`,
    }));
    const setMyCommands = vi.fn().mockResolvedValue(undefined);
    const runtimeLog = vi.fn();

    registerTelegramNativeCommands({
      ...buildParams(cfg),
      bot: {
        api: {
          setMyCommands,
          sendMessage: vi.fn().mockResolvedValue(undefined),
        },
        command: vi.fn(),
      } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
      runtime: { log: runtimeLog } as RuntimeEnv,
      telegramCfg: { customCommands } as TelegramAccountConfig,
      nativeEnabled: false,
      nativeSkillsEnabled: false,
    });

    const registeredCommands = setMyCommands.mock.calls[0]?.[0] as Array<{
      command: string;
      description: string;
    }>;
    expect(registeredCommands).toHaveLength(100);
    expect(registeredCommands).toEqual(customCommands.slice(0, 100));
    expect(runtimeLog).toHaveBeenCalledWith(
      "Telegram limits bots to 100 commands. 120 configured; registering first 100. Use channels.telegram.commands.native: false to disable, or reduce plugin/skill/custom commands.",
    );
  });

  it("passes agent-scoped media roots for plugin command replies with media", async () => {
    const commandHandlers = new Map<string, (ctx: unknown) => Promise<void>>();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true }, { id: "work" }],
      },
      bindings: [{ agentId: "work", match: { channel: "telegram", accountId: "default" } }],
    };

    pluginCommandMocks.getPluginCommandSpecs.mockReturnValue([
      {
        name: "plug",
        description: "Plugin command",
      },
    ]);
    pluginCommandMocks.matchPluginCommand.mockReturnValue({
      command: { key: "plug", requireAuth: false },
      args: undefined,
    });
    pluginCommandMocks.executePluginCommand.mockResolvedValue({
      text: "with media",
      mediaUrl: "/tmp/workspace-work/render.png",
    });

    registerTelegramNativeCommands({
      ...buildParams(cfg),
      bot: {
        api: {
          setMyCommands: vi.fn().mockResolvedValue(undefined),
          sendMessage,
        },
        command: vi.fn((name: string, cb: (ctx: unknown) => Promise<void>) => {
          commandHandlers.set(name, cb);
        }),
      } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
    });

    const handler = commandHandlers.get("plug");
    expect(handler).toBeTruthy();
    await handler?.({
      match: "",
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 123, type: "private" },
        from: { id: 456, username: "alice" },
      },
    });

    expect(deliveryMocks.deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaLocalRoots: expect.arrayContaining([path.join(STATE_DIR, "workspace-work")]),
      }),
    );
    expect(sendMessage).not.toHaveBeenCalledWith(123, "Command not found.");
  });
});
