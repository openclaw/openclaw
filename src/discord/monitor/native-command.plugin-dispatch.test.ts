import { ChannelType } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeCommandSpec } from "../../auto-reply/commands-registry.js";
import * as dispatcherModule from "../../auto-reply/reply/provider-dispatcher.js";
import type { OpenClawConfig } from "../../config/config.js";
import * as pluginCommandsModule from "../../plugins/commands.js";
import { createDiscordNativeCommand } from "./native-command.js";
import {
  createMockCommandInteraction,
  type MockCommandInteraction,
} from "./native-command.test-helpers.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

type ResolveConfiguredAcpBindingRecordFn =
  typeof import("../../acp/persistent-bindings.js").resolveConfiguredAcpBindingRecord;
type EnsureConfiguredAcpBindingSessionFn =
  typeof import("../../acp/persistent-bindings.js").ensureConfiguredAcpBindingSession;

const persistentBindingMocks = vi.hoisted(() => ({
  resolveConfiguredAcpBindingRecord: vi.fn<ResolveConfiguredAcpBindingRecordFn>(() => null),
  ensureConfiguredAcpBindingSession: vi.fn<EnsureConfiguredAcpBindingSessionFn>(async () => ({
    ok: true,
    sessionKey: "agent:codex:acp:binding:discord:default:seed",
  })),
}));

const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
}));

vi.mock("../../acp/persistent-bindings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../acp/persistent-bindings.js")>();
  return {
    ...actual,
    resolveConfiguredAcpBindingRecord: persistentBindingMocks.resolveConfiguredAcpBindingRecord,
    ensureConfiguredAcpBindingSession: persistentBindingMocks.ensureConfiguredAcpBindingSession,
  };
});

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: configMocks.loadConfig,
  };
});

function createInteraction(params?: {
  channelType?: ChannelType;
  channelId?: string;
  channelName?: string;
  channelTopic?: string;
  guildId?: string;
  guildName?: string;
}): MockCommandInteraction {
  return createMockCommandInteraction({
    userId: "owner",
    username: "tester",
    globalName: "Tester",
    channelType: params?.channelType ?? ChannelType.DM,
    channelId: params?.channelId ?? "dm-1",
    channelName: params?.channelName,
    channelTopic: params?.channelTopic,
    guildId: params?.guildId ?? null,
    guildName: params?.guildName,
    interactionId: "interaction-1",
  });
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

function createStatusCommand(cfg: OpenClawConfig) {
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

function setConfiguredBinding(channelId: string, boundSessionKey: string) {
  persistentBindingMocks.resolveConfiguredAcpBindingRecord.mockReturnValue({
    spec: {
      channel: "discord",
      accountId: "default",
      conversationId: channelId,
      agentId: "codex",
      mode: "persistent",
    },
    record: {
      bindingId: `config:acp:discord:default:${channelId}`,
      targetSessionKey: boundSessionKey,
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: channelId,
      },
      status: "active",
      boundAt: 0,
    },
  });
  persistentBindingMocks.ensureConfiguredAcpBindingSession.mockResolvedValue({
    ok: true,
    sessionKey: boundSessionKey,
  });
}

function createDispatchSpy() {
  return vi.spyOn(dispatcherModule, "dispatchReplyWithDispatcher").mockResolvedValue({
    counts: {
      final: 1,
      block: 0,
      tool: 0,
    },
  } as never);
}

function expectBoundSessionDispatch(
  dispatchSpy: ReturnType<typeof createDispatchSpy>,
  boundSessionKey: string,
) {
  expect(dispatchSpy).toHaveBeenCalledTimes(1);
  const dispatchCall = dispatchSpy.mock.calls[0]?.[0] as {
    ctx?: { SessionKey?: string; CommandTargetSessionKey?: string };
  };
  expect(dispatchCall.ctx?.SessionKey).toBe(boundSessionKey);
  expect(dispatchCall.ctx?.CommandTargetSessionKey).toBe(boundSessionKey);
  expect(persistentBindingMocks.resolveConfiguredAcpBindingRecord).toHaveBeenCalledTimes(1);
  expect(persistentBindingMocks.ensureConfiguredAcpBindingSession).toHaveBeenCalledTimes(1);
}

describe("Discord native plugin command dispatch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    persistentBindingMocks.resolveConfiguredAcpBindingRecord.mockReset();
    persistentBindingMocks.resolveConfiguredAcpBindingRecord.mockReturnValue(null);
    persistentBindingMocks.ensureConfiguredAcpBindingSession.mockReset();
    persistentBindingMocks.ensureConfiguredAcpBindingSession.mockResolvedValue({
      ok: true,
      sessionKey: "agent:codex:acp:binding:discord:default:seed",
    });
    configMocks.loadConfig.mockReset();
    configMocks.loadConfig.mockImplementation(() => createConfig());
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

  it("routes native slash commands through configured ACP Discord channel bindings", async () => {
    const guildId = "1459246755253325866";
    const channelId = "1478836151241412759";
    const boundSessionKey = "agent:codex:acp:binding:discord:default:feedface";
    const cfg = {
      commands: {
        useAccessGroups: false,
      },
      bindings: [
        {
          type: "acp",
          agentId: "codex",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "channel", id: channelId },
          },
          acp: {
            mode: "persistent",
          },
        },
      ],
    } as OpenClawConfig;
    configMocks.loadConfig.mockReturnValue(cfg);
    const command = createStatusCommand(cfg);
    const interaction = createInteraction({
      channelType: ChannelType.GuildText,
      channelId,
      guildId,
      guildName: "Ops",
    });

    setConfiguredBinding(channelId, boundSessionKey);

    vi.spyOn(pluginCommandsModule, "matchPluginCommand").mockReturnValue(null);
    const dispatchSpy = createDispatchSpy();

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expectBoundSessionDispatch(dispatchSpy, boundSessionKey);
  });

  it("routes Discord DM native slash commands through configured ACP bindings", async () => {
    const channelId = "dm-1";
    const boundSessionKey = "agent:codex:acp:binding:discord:default:dmfeedface";
    const cfg = {
      commands: {
        useAccessGroups: false,
      },
      bindings: [
        {
          type: "acp",
          agentId: "codex",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "direct", id: channelId },
          },
          acp: {
            mode: "persistent",
          },
        },
      ],
      channels: {
        discord: {
          dm: { enabled: true, policy: "open" },
        },
      },
    } as OpenClawConfig;
    configMocks.loadConfig.mockReturnValue(cfg);
    const command = createStatusCommand(cfg);
    const interaction = createInteraction({
      channelType: ChannelType.DM,
      channelId,
    });

    setConfiguredBinding(channelId, boundSessionKey);

    vi.spyOn(pluginCommandsModule, "matchPluginCommand").mockReturnValue(null);
    const dispatchSpy = createDispatchSpy();

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expectBoundSessionDispatch(dispatchSpy, boundSessionKey);
  });

  it("routes native guild slash commands through bound agent sessions and preserves guild metadata", async () => {
    const guildId = "1479614326774956167";
    const channelId = "1479615088053850253";
    const cfg = {
      commands: {
        useAccessGroups: false,
      },
      agents: {
        list: [{ id: "codex-orchestrator" }],
      },
      bindings: [
        {
          agentId: "codex-orchestrator",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "channel", id: channelId },
          },
        },
      ],
    } as OpenClawConfig;
    configMocks.loadConfig.mockReturnValue(cfg);
    const command = createStatusCommand(cfg);
    const interaction = createInteraction({
      channelType: ChannelType.GuildText,
      channelId,
      channelName: "codex",
      channelTopic: "Ship fixes.",
      guildId,
      guildName: "Scry Ops",
    });

    vi.spyOn(pluginCommandsModule, "matchPluginCommand").mockReturnValue(null);
    const dispatchSpy = createDispatchSpy();

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const dispatchCall = dispatchSpy.mock.calls[0]?.[0] as {
      ctx?: {
        SessionKey?: string;
        CommandTargetSessionKey?: string;
        ConversationLabel?: string;
        GroupSubject?: string;
        GroupChannel?: string;
        GroupSpace?: string;
      };
    };
    expect(configMocks.loadConfig).toHaveBeenCalled();
    expect(dispatchCall.ctx?.SessionKey).toBe("agent:codex-orchestrator:discord:slash:owner");
    expect(dispatchCall.ctx?.CommandTargetSessionKey).toBe(
      "agent:codex-orchestrator:discord:channel:1479615088053850253",
    );
    expect(dispatchCall.ctx?.ConversationLabel).toBe(
      "Scry Ops #codex channel id:1479615088053850253",
    );
    expect(dispatchCall.ctx?.GroupSubject).toBe("#codex");
    expect(dispatchCall.ctx?.GroupChannel).toBe("#codex");
    expect(dispatchCall.ctx?.GroupSpace).toBe(guildId);
    expect(persistentBindingMocks.resolveConfiguredAcpBindingRecord).toHaveBeenCalledTimes(1);
    expect(persistentBindingMocks.ensureConfiguredAcpBindingSession).not.toHaveBeenCalled();
  });

  it("keeps dispatcher execution on the fresh config used for route resolution", async () => {
    const guildId = "1479614326774956167";
    const channelId = "1479615088053850253";
    const startupCfg = {
      commands: {
        useAccessGroups: false,
      },
      agents: {
        list: [{ id: "main" }],
      },
      bindings: [],
    } as OpenClawConfig;
    const freshCfg = {
      commands: {
        useAccessGroups: false,
      },
      agents: {
        list: [{ id: "codex-orchestrator" }],
      },
      bindings: [
        {
          agentId: "codex-orchestrator",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "channel", id: channelId },
          },
        },
      ],
    } as OpenClawConfig;
    configMocks.loadConfig.mockReturnValue(freshCfg);
    const command = createStatusCommand(startupCfg);
    const interaction = createInteraction({
      channelType: ChannelType.GuildText,
      channelId,
      channelName: "codex",
      guildId,
      guildName: "Scry Ops",
    });

    vi.spyOn(pluginCommandsModule, "matchPluginCommand").mockReturnValue(null);
    const dispatchSpy = createDispatchSpy();

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(configMocks.loadConfig).toHaveBeenCalled();
    const dispatchCall = dispatchSpy.mock.calls[0]?.[0] as {
      cfg?: OpenClawConfig;
      ctx?: { CommandTargetSessionKey?: string };
    };
    expect(dispatchCall.cfg).toBe(freshCfg);
    expect(dispatchCall.ctx?.CommandTargetSessionKey).toBe(
      "agent:codex-orchestrator:discord:channel:1479615088053850253",
    );
  });
});
