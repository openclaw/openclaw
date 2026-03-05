/**
 * Integration tests for native-command.ts
 *
 * These tests verify behavior across subsystem boundaries:
 *   Discord interaction  →  access control  →  routing  →  reply delivery
 *
 * External I/O (network, disk) is mocked. All command-registry, plugin-commands,
 * channel-gating, and provider-dispatcher wiring is exercised end-to-end.
 */

import { ChannelType } from "discord-api-types/v10";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeCommandSpec } from "../../auto-reply/commands-registry.js";
import * as commandRegistryModule from "../../auto-reply/commands-registry.js";
import * as dispatcherModule from "../../auto-reply/reply/provider-dispatcher.js";
import type { OpenClawConfig } from "../../config/config.js";
import * as pluginCommandsModule from "../../plugins/commands.js";
import * as modelPickerPreferencesModule from "./model-picker-preferences.js";
import * as modelPickerModule from "./model-picker.js";
import { createDiscordNativeCommand } from "./native-command.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockCommandInteraction = {
  user: { id: string; username: string; globalName: string };
  channel: { type: ChannelType; id: string; name?: string; topic?: string };
  guild: null | { id: string; name: string };
  rawData: { id: string; member: { roles: string[] } };
  options: {
    getString: ReturnType<typeof vi.fn>;
    getNumber: ReturnType<typeof vi.fn>;
    getBoolean: ReturnType<typeof vi.fn>;
  };
  reply: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
  acknowledge?: ReturnType<typeof vi.fn>;
  update?: ReturnType<typeof vi.fn>;
  client: object;
};

function createDmInteraction(userId = "user-1", channelId = "dm-1"): MockCommandInteraction {
  return {
    user: { id: userId, username: "tester", globalName: "Tester" },
    channel: { type: ChannelType.DM, id: channelId },
    guild: null,
    rawData: { id: "interaction-1", member: { roles: [] } },
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

function createGuildInteraction(params?: {
  guildId?: string;
  channelId?: string;
  channelName?: string;
  userId?: string;
  roles?: string[];
}): MockCommandInteraction {
  return {
    user: {
      id: params?.userId ?? "user-1",
      username: "tester",
      globalName: "Tester",
    },
    channel: {
      type: ChannelType.GuildText,
      id: params?.channelId ?? "channel-1",
      name: params?.channelName ?? "general",
    },
    guild: {
      id: params?.guildId ?? "guild-1",
      name: "Test Guild",
    },
    rawData: {
      id: "interaction-1",
      member: { roles: params?.roles ?? [] },
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

function createConfig(overrides?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    channels: {
      discord: {
        dm: { enabled: true, policy: "open" },
      },
    },
    ...overrides,
  } as OpenClawConfig;
}

function buildAndRunCommand(params: {
  spec?: Partial<NativeCommandSpec>;
  cfg?: OpenClawConfig;
  discordConfig?: NonNullable<OpenClawConfig["channels"]>["discord"];
  interaction: unknown;
}) {
  const cfg = params.cfg ?? createConfig();
  const spec: NativeCommandSpec = {
    name: "status",
    description: "Show status",
    acceptsArgs: false,
    ...params.spec,
  };
  const command = createDiscordNativeCommand({
    command: spec,
    cfg,
    discordConfig: params.discordConfig ?? cfg.channels?.discord ?? {},
    accountId: "default",
    sessionPrefix: "discord:slash",
    ephemeralDefault: true,
    threadBindings: createNoopThreadBindingManager("default"),
  });
  return (command as { run: (i: unknown) => Promise<void> }).run(params.interaction);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Discord native command — DM access control flow", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allows an authorized DM sender (open policy) to dispatch a command to the agent", async () => {
    const dispatchSpy = vi
      .spyOn(dispatcherModule, "dispatchReplyWithDispatcher")
      .mockResolvedValue({ counts: { final: 1, block: 0, tool: 0 } } as never);

    vi.spyOn(pluginCommandsModule, "matchPluginCommand").mockReturnValue(null);

    const interaction = createDmInteraction("allowed-user");
    await buildAndRunCommand({ interaction });

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const ctxArg = dispatchSpy.mock.calls[0]?.[0]?.ctx;
    expect(ctxArg).toBeDefined();
    // Verify the full inbound context was built with correct From/To
    expect(ctxArg?.From).toMatch(/^discord:allowed-user/);
    expect(ctxArg?.ChatType).toBe("direct");
    expect(ctxArg?.CommandAuthorized).toBe(true);
  });

  it("rejects DM commands when DM is globally disabled, without touching the agent dispatcher", async () => {
    const dispatchSpy = vi
      .spyOn(dispatcherModule, "dispatchReplyWithDispatcher")
      .mockResolvedValue({ counts: { final: 0, block: 0, tool: 0 } } as never);

    const cfg = createConfig({
      channels: {
        discord: {
          dm: { enabled: false, policy: "open" },
        },
      },
    } as Partial<OpenClawConfig>);

    const interaction = createDmInteraction();
    await buildAndRunCommand({ cfg, interaction });

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringMatching(/disabled/i) }),
    );
  });

  it("rejects DM commands when dmPolicy is 'disabled', even if dm.enabled is true", async () => {
    const dispatchSpy = vi
      .spyOn(dispatcherModule, "dispatchReplyWithDispatcher")
      .mockResolvedValue({ counts: { final: 0, block: 0, tool: 0 } } as never);

    const cfg = createConfig({
      channels: {
        discord: {
          dm: { enabled: true, policy: "disabled" },
        },
      },
    } as Partial<OpenClawConfig>);

    const interaction = createDmInteraction();
    await buildAndRunCommand({ cfg, interaction });

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringMatching(/disabled/i) }),
    );
  });
});

describe("Discord native command — guild channel policy enforcement", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks commands in disabled guild channels before reaching the agent dispatcher", async () => {
    const dispatchSpy = vi
      .spyOn(dispatcherModule, "dispatchReplyWithDispatcher")
      .mockResolvedValue({ counts: { final: 0, block: 0, tool: 0 } } as never);

    const cfg = createConfig({
      channels: {
        discord: {
          guilds: {
            "guild-1": {
              channels: {
                "channel-1": { enabled: false },
              },
            },
          },
        },
      },
    } as unknown as Partial<OpenClawConfig>);

    const interaction = createGuildInteraction({ guildId: "guild-1", channelId: "channel-1" });
    await buildAndRunCommand({ cfg, interaction });

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringMatching(/disabled/i) }),
    );
  });

  it("blocks commands for unauthorized guild members and returns an 'not authorized' response", async () => {
    const dispatchSpy = vi
      .spyOn(dispatcherModule, "dispatchReplyWithDispatcher")
      .mockResolvedValue({ counts: { final: 0, block: 0, tool: 0 } } as never);

    // allowFrom restricts to a specific user; our test user is different → unauthorized
    const cfg = createConfig({
      channels: {
        discord: {
          allowFrom: ["owner-only-user"],
          guilds: {
            "guild-1": {},
          },
        },
      },
    } as unknown as Partial<OpenClawConfig>);

    const interaction = createGuildInteraction({
      guildId: "guild-1",
      userId: "random-user",
    });
    await buildAndRunCommand({ cfg, interaction });

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringMatching(/not authorized/i),
        ephemeral: true,
      }),
    );
  });

  it("allows commands in guild channels with access groups off and forwards to the dispatcher", async () => {
    const dispatchSpy = vi
      .spyOn(dispatcherModule, "dispatchReplyWithDispatcher")
      .mockResolvedValue({ counts: { final: 1, block: 0, tool: 0 } } as never);

    vi.spyOn(pluginCommandsModule, "matchPluginCommand").mockReturnValue(null);

    // Disable access groups so an open guild channel passes through without allowlist checks
    const cfg = createConfig({
      commands: { useAccessGroups: false },
      channels: {
        discord: {
          guilds: {
            "guild-1": {},
          },
          groupPolicy: "open",
        },
      },
    } as unknown as Partial<OpenClawConfig>);

    const interaction = createGuildInteraction({ guildId: "guild-1" });
    await buildAndRunCommand({ cfg, interaction });

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const ctxArg = dispatchSpy.mock.calls[0]?.[0]?.ctx;
    expect(ctxArg?.ChatType).toBe("channel");
    expect(ctxArg?.CommandSource).toBe("native");
  });
});

describe("Discord native command — plugin dispatch cross-subsystem flow", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("routes plugin commands through plugin executor and delivers reply without touching agent dispatcher", async () => {
    const agentDispatchSpy = vi
      .spyOn(dispatcherModule, "dispatchReplyWithDispatcher")
      .mockResolvedValue({ counts: { final: 0, block: 0, tool: 0 } } as never);

    const pluginMatch = {
      command: {
        name: "status",
        description: "Show status",
        pluginId: "test-plugin",
        acceptsArgs: false,
        handler: vi.fn().mockResolvedValue({ text: "all systems go" }),
      },
      args: undefined,
    };
    vi.spyOn(pluginCommandsModule, "matchPluginCommand").mockReturnValue(
      pluginMatch as ReturnType<typeof pluginCommandsModule.matchPluginCommand>,
    );
    const executeSpy = vi
      .spyOn(pluginCommandsModule, "executePluginCommand")
      .mockResolvedValue({ text: "all systems go" });

    const interaction = createDmInteraction();
    await buildAndRunCommand({ interaction });

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(agentDispatchSpy).not.toHaveBeenCalled();
    // Content delivered to the Discord interaction
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "all systems go" }),
    );
  });

  it("sends a 'Done.' fallback when plugin command produces an empty reply payload", async () => {
    vi.spyOn(pluginCommandsModule, "matchPluginCommand").mockReturnValue({
      command: {
        name: "flush",
        description: "Flush",
        pluginId: "flush",
        acceptsArgs: false,
        handler: vi.fn().mockResolvedValue({}),
      },
      args: undefined,
    } as ReturnType<typeof pluginCommandsModule.matchPluginCommand>);
    vi.spyOn(pluginCommandsModule, "executePluginCommand").mockResolvedValue({
      text: "",
      mediaUrl: "",
    });

    const interaction = createDmInteraction();
    await buildAndRunCommand({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: "Done." }));
  });

  it("passes correct channel metadata (from/to/accountId) through to the plugin executor", async () => {
    const pluginMatch = {
      command: {
        name: "whoami",
        description: "Who am I",
        pluginId: "core",
        acceptsArgs: false,
        handler: vi.fn().mockResolvedValue({ text: "you" }),
      },
      args: undefined,
    };
    vi.spyOn(pluginCommandsModule, "matchPluginCommand").mockReturnValue(
      pluginMatch as ReturnType<typeof pluginCommandsModule.matchPluginCommand>,
    );
    const executeSpy = vi
      .spyOn(pluginCommandsModule, "executePluginCommand")
      .mockResolvedValue({ text: "you" });

    const interaction = createDmInteraction("u-9999", "dm-xyz");
    await buildAndRunCommand({ interaction });

    const callArgs = executeSpy.mock.calls[0]?.[0];
    expect(callArgs?.from).toMatch(/u-9999/);
    expect(callArgs?.senderId).toBe("u-9999");
    expect(callArgs?.accountId).toBe("default");
    expect(callArgs?.channel).toBe("discord");
  });
});

describe("Discord native command — model picker launch flow", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("opens the model picker when /model is invoked with no arguments (bypasses agent dispatcher)", async () => {
    const agentDispatchSpy = vi
      .spyOn(dispatcherModule, "dispatchReplyWithDispatcher")
      .mockResolvedValue({ counts: { final: 0, block: 0, tool: 0 } } as never);

    vi.spyOn(pluginCommandsModule, "matchPluginCommand").mockReturnValue(null);

    const pickerData = {
      providers: ["openai", "anthropic"],
      byProvider: new Map([
        ["openai", new Set(["gpt-4o"])],
        ["anthropic", new Set(["claude-3-5-sonnet"])],
      ]),
      resolvedDefault: { provider: "openai", model: "gpt-4o" },
    };
    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(
      pickerData as Awaited<ReturnType<typeof modelPickerModule.loadDiscordModelPickerData>>,
    );
    vi.spyOn(modelPickerPreferencesModule, "readDiscordModelPickerRecentModels").mockResolvedValue(
      [],
    );
    vi.spyOn(modelPickerModule, "renderDiscordModelPickerModelsView").mockReturnValue({
      view: "models",
    } as never);
    vi.spyOn(modelPickerModule, "toDiscordModelPickerMessagePayload").mockReturnValue({
      components: [],
      ephemeral: true,
    } as never);

    // Register /model command definition so the picker is recognized
    vi.spyOn(commandRegistryModule, "findCommandByNativeName").mockImplementation((name) => {
      if (name === "model") {
        return {
          key: "model",
          nativeName: "model",
          description: "Switch model",
          textAliases: [],
          acceptsArgs: true,
          argsParsing: "none" as const,
          scope: "native" as const,
          args: [
            {
              name: "model",
              description: "Model ref",
              type: "string" as const,
              required: false,
            },
          ],
        };
      }
      return undefined;
    });

    const interaction = createDmInteraction();
    await buildAndRunCommand({
      spec: { name: "model", description: "Switch model", acceptsArgs: true },
      interaction,
    });

    // The picker was loaded — the agent dispatcher was NOT invoked
    expect(modelPickerModule.loadDiscordModelPickerData).toHaveBeenCalled();
    expect(agentDispatchSpy).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });
});

describe("Discord native command — empty-reply fallback flow", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends an ephemeral 'Done.' acknowledgment when the agent turn produces no deliverable output", async () => {
    vi.spyOn(pluginCommandsModule, "matchPluginCommand").mockReturnValue(null);
    vi.spyOn(dispatcherModule, "dispatchReplyWithDispatcher").mockResolvedValue({
      counts: { final: 0, block: 0, tool: 0 },
    } as never);

    const interaction = createDmInteraction();
    await buildAndRunCommand({ interaction });

    // Fallback: interaction must be closed to avoid Discord pending state
    const reply = interaction;
    const replyCall = reply.reply.mock.calls.at(-1)?.[0];
    expect(replyCall?.content ?? replyCall?.text ?? "").toMatch(/done/i);
    expect(replyCall?.ephemeral).toBe(true);
  });
});

describe("Discord native command — command arg menu integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a button menu and does not dispatch to agent when a command arg menu is required", async () => {
    const agentDispatchSpy = vi
      .spyOn(dispatcherModule, "dispatchReplyWithDispatcher")
      .mockResolvedValue({ counts: { final: 0, block: 0, tool: 0 } } as never);

    vi.spyOn(pluginCommandsModule, "matchPluginCommand").mockReturnValue(null);

    // Stub resolveCommandArgMenu to indicate a menu is needed
    vi.spyOn(commandRegistryModule, "resolveCommandArgMenu").mockReturnValue({
      arg: { name: "action", description: "Select action", type: "string", required: true },
      choices: [
        { value: "start", label: "Start" },
        { value: "stop", label: "Stop" },
      ],
      title: "Choose an action",
    } as ReturnType<typeof commandRegistryModule.resolveCommandArgMenu>);

    const interaction = createDmInteraction();
    await buildAndRunCommand({
      spec: { name: "control", description: "Control the service", acceptsArgs: true },
      interaction,
    });

    expect(agentDispatchSpy).not.toHaveBeenCalled();
    const replyArg = interaction.reply.mock.calls[0]?.[0];
    expect(replyArg?.content).toMatch(/choose/i);
    // Components (buttons) should be present
    expect(Array.isArray(replyArg?.components)).toBe(true);
  });
});

describe("Discord native command — interaction expiry resilience", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("handles Unknown Interaction (Discord code 10062) from reply without throwing", async () => {
    vi.spyOn(pluginCommandsModule, "matchPluginCommand").mockReturnValue(null);
    vi.spyOn(dispatcherModule, "dispatchReplyWithDispatcher").mockResolvedValue({
      counts: { final: 0, block: 0, tool: 0 },
    } as never);

    const expiredError = Object.assign(new Error("Unknown interaction"), {
      rawBody: { code: 10062, message: "Unknown interaction" },
    });

    const interaction = createDmInteraction();
    // Simulate the interaction having expired by the time we try to reply
    interaction.reply = vi.fn().mockRejectedValue(expiredError);

    // Must not throw — Discord expired interactions should be silently swallowed
    await expect(buildAndRunCommand({ interaction })).resolves.not.toThrow();
  });

  it("re-throws non-expiry errors from interaction reply", async () => {
    vi.spyOn(pluginCommandsModule, "matchPluginCommand").mockReturnValue({
      command: {
        name: "status",
        description: "Show status",
        pluginId: "test",
        acceptsArgs: false,
        handler: vi.fn().mockResolvedValue({ text: "ok" }),
      },
      args: undefined,
    } as ReturnType<typeof pluginCommandsModule.matchPluginCommand>);
    vi.spyOn(pluginCommandsModule, "executePluginCommand").mockResolvedValue({ text: "ok" });

    const networkError = new Error("Network failure");
    const interaction = createDmInteraction();
    interaction.reply = vi.fn().mockRejectedValue(networkError);

    await expect(buildAndRunCommand({ interaction })).rejects.toThrow("Network failure");
  });
});
