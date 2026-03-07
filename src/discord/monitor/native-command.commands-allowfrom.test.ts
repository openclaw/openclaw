import { ChannelType } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeCommandSpec } from "../../auto-reply/commands-registry.js";
import * as dispatcherModule from "../../auto-reply/reply/provider-dispatcher.js";
import type { OpenClawConfig } from "../../config/config.js";
import * as pluginCommandsModule from "../../plugins/commands.js";
import { createDiscordNativeCommand } from "./native-command.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

type MockCommandInteraction = {
  user: { id: string; username: string; globalName: string };
  channel: { type: ChannelType; id: string };
  guild: { id: string; name?: string } | null;
  rawData: { id: string; member: { roles: string[] } };
  options: {
    getString: ReturnType<typeof vi.fn>;
    getNumber: ReturnType<typeof vi.fn>;
    getBoolean: ReturnType<typeof vi.fn>;
  };
  reply: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
  client: object;
};

function createInteraction(params?: {
  userId?: string;
  channelId?: string;
  guildId?: string;
  guildName?: string;
}): MockCommandInteraction {
  return {
    user: {
      id: params?.userId ?? "123456789012345678",
      username: "discord-user",
      globalName: "Discord User",
    },
    channel: {
      type: ChannelType.GuildText,
      id: params?.channelId ?? "234567890123456789",
    },
    guild: {
      id: params?.guildId ?? "345678901234567890",
      name: params?.guildName ?? "Test Guild",
    },
    rawData: {
      id: "interaction-1",
      member: { roles: [] },
    },
    options: {
      getString: vi.fn().mockReturnValue(null),
      getNumber: vi.fn().mockReturnValue(null),
      getBoolean: vi.fn().mockReturnValue(null),
    },
    reply: vi.fn().mockResolvedValue({ ok: true }),
    followUp: vi.fn().mockResolvedValue({ ok: true }),
    client: {},
  };
}

function createConfig(): OpenClawConfig {
  return {
    commands: {
      allowFrom: {
        discord: ["user:123456789012345678"],
      },
    },
    channels: {
      discord: {
        groupPolicy: "allowlist",
        guilds: {
          "345678901234567890": {
            channels: {
              "234567890123456789": {
                allow: true,
                requireMention: false,
              },
            },
          },
        },
      },
    },
  } as OpenClawConfig;
}

function createCommand(cfg: OpenClawConfig) {
  const commandSpec: NativeCommandSpec = {
    name: "status",
    description: "Status",
    acceptsArgs: false,
  };
  return createDiscordNativeCommand({
    command: commandSpec,
    cfg,
    discordConfig: cfg.channels?.discord ?? {},
    accountId: "default",
    sessionPrefix: "discord:slash",
    ephemeralDefault: true,
    threadBindings: createNoopThreadBindingManager("default"),
  });
}

describe("Discord native slash commands with commands.allowFrom", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("authorizes guild slash commands when commands.allowFrom.discord matches the sender", async () => {
    const cfg = createConfig();
    const command = createCommand(cfg);
    const interaction = createInteraction();

    vi.spyOn(pluginCommandsModule, "matchPluginCommand").mockReturnValue(null);
    const dispatchSpy = vi
      .spyOn(dispatcherModule, "dispatchReplyWithDispatcher")
      .mockResolvedValue({
        counts: {
          final: 1,
          block: 0,
          tool: 0,
        },
      } as never);

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(interaction.reply).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: "You are not authorized to use this command." }),
    );
  });

  it("authorizes guild slash commands from the global commands.allowFrom list when provider-specific allowFrom is missing", async () => {
    const cfg = createConfig();
    cfg.commands = {
      allowFrom: {
        "*": ["user:123456789012345678"],
      },
    };
    const command = createCommand(cfg);
    const interaction = createInteraction();

    vi.spyOn(pluginCommandsModule, "matchPluginCommand").mockReturnValue(null);
    const dispatchSpy = vi
      .spyOn(dispatcherModule, "dispatchReplyWithDispatcher")
      .mockResolvedValue({
        counts: {
          final: 1,
          block: 0,
          tool: 0,
        },
      } as never);

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(interaction.reply).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: "You are not authorized to use this command." }),
    );
  });

  it("authorizes guild slash commands when commands.useAccessGroups is false and commands.allowFrom.discord matches the sender", async () => {
    const cfg = createConfig();
    cfg.commands = {
      ...cfg.commands,
      useAccessGroups: false,
    };
    const command = createCommand(cfg);
    const interaction = createInteraction();

    vi.spyOn(pluginCommandsModule, "matchPluginCommand").mockReturnValue(null);
    const dispatchSpy = vi
      .spyOn(dispatcherModule, "dispatchReplyWithDispatcher")
      .mockResolvedValue({
        counts: {
          final: 1,
          block: 0,
          tool: 0,
        },
      } as never);

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(interaction.reply).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: "You are not authorized to use this command." }),
    );
  });

  it("rejects guild slash commands when commands.allowFrom.discord does not match the sender", async () => {
    const cfg = createConfig();
    const command = createCommand(cfg);
    const interaction = createInteraction({ userId: "999999999999999999" });

    vi.spyOn(pluginCommandsModule, "matchPluginCommand").mockReturnValue(null);
    const dispatchSpy = vi
      .spyOn(dispatcherModule, "dispatchReplyWithDispatcher")
      .mockResolvedValue({
        counts: {
          final: 1,
          block: 0,
          tool: 0,
        },
      } as never);

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "You are not authorized to use this command.",
        ephemeral: true,
      }),
    );
  });

  it("rejects guild slash commands when commands.useAccessGroups is false and commands.allowFrom.discord does not match the sender", async () => {
    const cfg = createConfig();
    cfg.commands = {
      ...cfg.commands,
      useAccessGroups: false,
    };
    const command = createCommand(cfg);
    const interaction = createInteraction({ userId: "999999999999999999" });

    vi.spyOn(pluginCommandsModule, "matchPluginCommand").mockReturnValue(null);
    const dispatchSpy = vi
      .spyOn(dispatcherModule, "dispatchReplyWithDispatcher")
      .mockResolvedValue({
        counts: {
          final: 1,
          block: 0,
          tool: 0,
        },
      } as never);

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "You are not authorized to use this command.",
        ephemeral: true,
      }),
    );
  });
});
