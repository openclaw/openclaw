import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";

const {
  createDiscordNativeCommandMock,
  createNoopThreadBindingManagerMock,
  createThreadBindingManagerMock,
  createdBindingManagers,
  listNativeCommandSpecsForConfigMock,
  listSkillCommandsForAgentsMock,
  monitorLifecycleMock,
  resolveDiscordAccountMock,
  resolveDiscordAllowlistConfigMock,
  resolveNativeCommandsEnabledMock,
  resolveNativeSkillsEnabledMock,
} = vi.hoisted(() => {
  const createdBindingManagers: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
  return {
    createDiscordNativeCommandMock: vi.fn(() => ({ name: "mock-command" })),
    createNoopThreadBindingManagerMock: vi.fn(() => {
      const manager = { stop: vi.fn() };
      createdBindingManagers.push(manager);
      return manager;
    }),
    createThreadBindingManagerMock: vi.fn(() => {
      const manager = { stop: vi.fn() };
      createdBindingManagers.push(manager);
      return manager;
    }),
    createdBindingManagers,
    listNativeCommandSpecsForConfigMock: vi.fn(() => [{ name: "cmd" }]),
    listSkillCommandsForAgentsMock: vi.fn(() => []),
    monitorLifecycleMock: vi.fn(async (params: { threadBindings: { stop: () => void } }) => {
      params.threadBindings.stop();
    }),
    resolveDiscordAccountMock: vi.fn(() => ({
      accountId: "default",
      token: "cfg-token",
      config: {
        commands: { native: true, nativeSkills: false },
        voice: { enabled: false },
        agentComponents: { enabled: false },
        execApprovals: { enabled: false },
      },
    })),
    resolveDiscordAllowlistConfigMock: vi.fn(async () => ({
      guildEntries: undefined,
      allowFrom: undefined,
    })),
    resolveNativeCommandsEnabledMock: vi.fn(() => true),
    resolveNativeSkillsEnabledMock: vi.fn(() => false),
  };
});

vi.mock("@buape/carbon", () => {
  class ReadyListener {}
  class Client {
    listeners: unknown[];
    rest: { put: ReturnType<typeof vi.fn> };
    constructor(_options: unknown, handlers: { listeners?: unknown[] }) {
      this.listeners = handlers.listeners ?? [];
      this.rest = { put: vi.fn(async () => undefined) };
    }
    async handleDeployRequest() {
      return undefined;
    }
    async fetchUser(_target: string) {
      return { id: "bot-1" };
    }
    getPlugin(_name: string) {
      return undefined;
    }
  }
  return { Client, ReadyListener };
});

vi.mock("@buape/carbon/gateway", () => ({
  GatewayCloseCodes: { DisallowedIntents: 4014 },
}));

vi.mock("@buape/carbon/voice", () => ({
  VoicePlugin: class VoicePlugin {},
}));

vi.mock("../../auto-reply/chunk.js", () => ({
  resolveTextChunkLimit: () => 2000,
}));

vi.mock("../../auto-reply/commands-registry.js", () => ({
  listNativeCommandSpecsForConfig: listNativeCommandSpecsForConfigMock,
}));

vi.mock("../../auto-reply/skill-commands.js", () => ({
  listSkillCommandsForAgents: listSkillCommandsForAgentsMock,
}));

vi.mock("../../config/commands.js", () => ({
  isNativeCommandsExplicitlyDisabled: () => false,
  resolveNativeCommandsEnabled: resolveNativeCommandsEnabledMock,
  resolveNativeSkillsEnabled: resolveNativeSkillsEnabledMock,
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => ({}),
}));

vi.mock("../../globals.js", () => ({
  danger: (v: string) => v,
  logVerbose: vi.fn(),
  shouldLogVerbose: () => false,
  warn: (v: string) => v,
}));

vi.mock("../../infra/errors.js", () => ({
  formatErrorMessage: (err: unknown) => String(err),
}));

vi.mock("../../infra/retry-policy.js", () => ({
  createDiscordRetryRunner: () => async (run: () => Promise<unknown>) => run(),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: vi.fn(), error: vi.fn() }),
}));

vi.mock("../../runtime.js", () => ({
  createNonExitingRuntime: () => ({ log: vi.fn(), error: vi.fn(), exit: vi.fn() }),
}));

vi.mock("../accounts.js", () => ({
  resolveDiscordAccount: resolveDiscordAccountMock,
}));

vi.mock("../probe.js", () => ({
  fetchDiscordApplicationId: async () => "app-1",
}));

vi.mock("../token.js", () => ({
  normalizeDiscordToken: (value?: string) => value,
}));

vi.mock("../voice/command.js", () => ({
  createDiscordVoiceCommand: () => ({ name: "voice-command" }),
}));

vi.mock("../voice/manager.js", () => ({
  DiscordVoiceManager: class DiscordVoiceManager {},
  DiscordVoiceReadyListener: class DiscordVoiceReadyListener {},
}));

vi.mock("./agent-components.js", () => ({
  createAgentComponentButton: () => ({ id: "btn" }),
  createAgentSelectMenu: () => ({ id: "menu" }),
  createDiscordComponentButton: () => ({ id: "btn2" }),
  createDiscordComponentChannelSelect: () => ({ id: "channel" }),
  createDiscordComponentMentionableSelect: () => ({ id: "mentionable" }),
  createDiscordComponentModal: () => ({ id: "modal" }),
  createDiscordComponentRoleSelect: () => ({ id: "role" }),
  createDiscordComponentStringSelect: () => ({ id: "string" }),
  createDiscordComponentUserSelect: () => ({ id: "user" }),
}));

vi.mock("./commands.js", () => ({
  resolveDiscordSlashCommandConfig: () => ({ ephemeral: false }),
}));

vi.mock("./exec-approvals.js", () => ({
  createExecApprovalButton: () => ({ id: "exec-approval" }),
  DiscordExecApprovalHandler: class DiscordExecApprovalHandler {
    async start() {
      return undefined;
    }
    async stop() {
      return undefined;
    }
  },
}));

vi.mock("./gateway-plugin.js", () => ({
  createDiscordGatewayPlugin: () => ({ id: "gateway-plugin" }),
}));

vi.mock("./listeners.js", () => ({
  DiscordMessageListener: class DiscordMessageListener {},
  DiscordPresenceListener: class DiscordPresenceListener {},
  DiscordReactionListener: class DiscordReactionListener {},
  DiscordReactionRemoveListener: class DiscordReactionRemoveListener {},
  registerDiscordListener: vi.fn(),
}));

vi.mock("./message-handler.js", () => ({
  createDiscordMessageHandler: () => ({ handle: vi.fn() }),
}));

vi.mock("./native-command.js", () => ({
  createDiscordCommandArgFallbackButton: () => ({ id: "arg-fallback" }),
  createDiscordModelPickerFallbackButton: () => ({ id: "model-fallback-btn" }),
  createDiscordModelPickerFallbackSelect: () => ({ id: "model-fallback-select" }),
  createDiscordNativeCommand: createDiscordNativeCommandMock,
}));

vi.mock("./presence.js", () => ({
  resolveDiscordPresenceUpdate: () => undefined,
}));

vi.mock("./provider.allowlist.js", () => ({
  resolveDiscordAllowlistConfig: resolveDiscordAllowlistConfigMock,
}));

vi.mock("./provider.lifecycle.js", () => ({
  runDiscordGatewayLifecycle: monitorLifecycleMock,
}));

vi.mock("./rest-fetch.js", () => ({
  resolveDiscordRestFetch: () => async () => undefined,
}));

vi.mock("./thread-bindings.js", () => ({
  createNoopThreadBindingManager: createNoopThreadBindingManagerMock,
  createThreadBindingManager: createThreadBindingManagerMock,
}));

describe("monitorDiscordProvider", () => {
  const baseRuntime = (): RuntimeEnv => {
    return {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
  };

  const baseConfig = (): OpenClawConfig =>
    ({
      channels: {
        discord: {
          accounts: {
            default: {},
          },
        },
      },
    }) as OpenClawConfig;

  beforeEach(() => {
    createDiscordNativeCommandMock.mockClear().mockReturnValue({ name: "mock-command" });
    createNoopThreadBindingManagerMock.mockClear();
    createThreadBindingManagerMock.mockClear();
    createdBindingManagers.length = 0;
    listNativeCommandSpecsForConfigMock.mockClear().mockReturnValue([{ name: "cmd" }]);
    listSkillCommandsForAgentsMock.mockClear().mockReturnValue([]);
    monitorLifecycleMock.mockClear().mockImplementation(async (params) => {
      params.threadBindings.stop();
    });
    resolveDiscordAccountMock.mockClear();
    resolveDiscordAllowlistConfigMock.mockClear().mockResolvedValue({
      guildEntries: undefined,
      allowFrom: undefined,
    });
    resolveNativeCommandsEnabledMock.mockClear().mockReturnValue(true);
    resolveNativeSkillsEnabledMock.mockClear().mockReturnValue(false);
  });

  it("stops thread bindings when startup fails before lifecycle begins", async () => {
    const { monitorDiscordProvider } = await import("./provider.js");
    createDiscordNativeCommandMock.mockImplementation(() => {
      throw new Error("native command boom");
    });

    await expect(
      monitorDiscordProvider({
        config: baseConfig(),
        runtime: baseRuntime(),
      }),
    ).rejects.toThrow("native command boom");

    expect(monitorLifecycleMock).not.toHaveBeenCalled();
    expect(createdBindingManagers).toHaveLength(1);
    expect(createdBindingManagers[0]?.stop).toHaveBeenCalledTimes(1);
  });

  it("does not double-stop thread bindings when lifecycle performs cleanup", async () => {
    const { monitorDiscordProvider } = await import("./provider.js");

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    expect(monitorLifecycleMock).toHaveBeenCalledTimes(1);
    expect(createdBindingManagers).toHaveLength(1);
    expect(createdBindingManagers[0]?.stop).toHaveBeenCalledTimes(1);
  });
});
