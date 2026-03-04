import { ChannelType } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeCommandSpec } from "../../auto-reply/commands-registry.js";
import * as dispatcherModule from "../../auto-reply/reply/provider-dispatcher.js";
import type { OpenClawConfig } from "../../config/config.js";
import * as pluginCommandsModule from "../../plugins/commands.js";
import { createDiscordNativeCommand } from "./native-command.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

type MockCommandInteraction = {
  user: { id: string; username: string; globalName: string };
  channel: { type: ChannelType; id: string; name?: string };
  guild: { id: string; name: string } | null;
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
  channelType?: ChannelType;
  channelId?: string;
  channelName?: string;
  guild?: { id: string; name: string } | null;
}): MockCommandInteraction {
  return {
    user: {
      id: params?.userId ?? "owner",
      username: "tester",
      globalName: "Tester",
    },
    channel: {
      type: params?.channelType ?? ChannelType.DM,
      id: params?.channelId ?? "dm-1",
      ...(params?.channelName ? { name: params.channelName } : {}),
    },
    guild: params?.guild ?? null,
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
    channels: {
      discord: {
        dm: { enabled: true, policy: "open" },
      },
    },
  } as OpenClawConfig;
}

describe("Discord native plugin command dispatch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("executes matched plugin commands directly without invoking the agent dispatcher", async () => {
    const cfg = createConfig();
    const commandSpec: NativeCommandSpec = {
      name: "cron_jobs",
      description: "List cron jobs",
      acceptsArgs: false,
    };
    const command = createDiscordNativeCommand({
      command: commandSpec,
      cfg,
      discordConfig: cfg.channels?.discord ?? {},
      accountId: "default",
      sessionPrefix: "discord:slash",
      ephemeralDefault: true,
      threadBindings: createNoopThreadBindingManager("default"),
    });
    const interaction = createInteraction();
    const pluginMatch = {
      command: {
        name: "cron_jobs",
        description: "List cron jobs",
        pluginId: "cron-jobs",
        acceptsArgs: false,
        handler: vi.fn().mockResolvedValue({ text: "jobs" }),
      },
      args: undefined,
    };

    vi.spyOn(pluginCommandsModule, "matchPluginCommand").mockReturnValue(
      pluginMatch as ReturnType<typeof pluginCommandsModule.matchPluginCommand>,
    );
    const executeSpy = vi
      .spyOn(pluginCommandsModule, "executePluginCommand")
      .mockResolvedValue({ text: "direct plugin output" });
    const dispatchSpy = vi
      .spyOn(dispatcherModule, "dispatchReplyWithDispatcher")
      .mockResolvedValue({} as never);

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "direct plugin output" }),
    );
  });

  it("rejects unauthorized slash command users when commands.allowFrom is configured", async () => {
    const cfg = createConfig();
    cfg.commands = {
      allowFrom: {
        discord: ["allowed-user"],
      },
    };
    const commandSpec: NativeCommandSpec = {
      name: "status",
      description: "Show status",
      acceptsArgs: false,
    };
    const command = createDiscordNativeCommand({
      command: commandSpec,
      cfg,
      discordConfig: cfg.channels?.discord ?? {},
      accountId: "default",
      sessionPrefix: "discord:slash",
      ephemeralDefault: true,
      threadBindings: createNoopThreadBindingManager("default"),
    });
    const interaction = createInteraction({
      channelType: ChannelType.GuildText,
      channelId: "channel-1",
      channelName: "general",
      guild: { id: "guild-1", name: "Guild" },
      userId: "not-allowed",
    });

    vi.spyOn(pluginCommandsModule, "matchPluginCommand").mockReturnValue(null);
    const dispatchSpy = vi
      .spyOn(dispatcherModule, "dispatchReplyWithDispatcher")
      .mockResolvedValue({} as never);

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(dispatchSpy).not.toHaveBeenCalled();
    const replies = [...interaction.reply.mock.calls, ...interaction.followUp.mock.calls].map(
      (call) => call[0] as { content?: string; ephemeral?: boolean },
    );
    expect(
      replies.some(
        (payload) =>
          payload.content === "You are not authorized to use this command." &&
          payload.ephemeral === true,
      ),
    ).toBe(true);
  });
});
