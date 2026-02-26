import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";

const {
  clientFetchUserMock,
  clientGetPluginMock,
  createDiscordNativeCommandMock,
  createNoopThreadBindingManagerMock,
  createThreadBindingManagerMock,
  reconcileAcpThreadBindingsOnStartupMock,
  createdBindingManagers,
  listNativeCommandSpecsForConfigMock,
  listSkillCommandsForAgentsMock,
  monitorLifecycleMock,
  resolveDiscordAccountMock,
  resolveDiscordAllowlistConfigMock,
  resolveNativeCommandsEnabledMock,
  resolveNativeSkillsEnabledMock,
  resolveThreadBindingSessionTtlMsMock,
  resolveThreadBindingsEnabledMock,
} = vi.hoisted(() => {
  const createdBindingManagers: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
  return {
    clientFetchUserMock: vi.fn(async (_target: string) => ({ id: "bot-1" })),
    clientGetPluginMock: vi.fn<(_name: string) => unknown>(() => undefined),
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
    reconcileAcpThreadBindingsOnStartupMock: vi.fn(() => ({
      checked: 0,
      removed: 0,
      staleSessionKeys: [],
    })),
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
    resolveThreadBindingSessionTtlMsMock: vi.fn(() => undefined),
    resolveThreadBindingsEnabledMock: vi.fn(() => true),
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
    async fetchUser(target: string) {
      return await clientFetchUserMock(target);
    }
    getPlugin(name: string) {
      return clientGetPluginMock(name);
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
  reconcileAcpThreadBindingsOnStartup: reconcileAcpThreadBindingsOnStartupMock,
  resolveThreadBindingSessionTtlMs: resolveThreadBindingSessionTtlMsMock,
  resolveThreadBindingsEnabled: resolveThreadBindingsEnabledMock,
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
    clientFetchUserMock.mockClear().mockResolvedValue({ id: "bot-1" });
    clientGetPluginMock.mockClear().mockReturnValue(undefined);
    createDiscordNativeCommandMock.mockClear().mockReturnValue({ name: "mock-command" });
    createNoopThreadBindingManagerMock.mockClear();
    createThreadBindingManagerMock.mockClear();
    reconcileAcpThreadBindingsOnStartupMock.mockClear().mockReturnValue({
      checked: 0,
      removed: 0,
      staleSessionKeys: [],
    });
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
    resolveThreadBindingSessionTtlMsMock.mockClear().mockReturnValue(undefined);
    resolveThreadBindingsEnabledMock.mockClear().mockReturnValue(true);
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
    expect(reconcileAcpThreadBindingsOnStartupMock).toHaveBeenCalledTimes(1);
  });

  it("captures gateway errors emitted before lifecycle wait starts", async () => {
    const { monitorDiscordProvider } = await import("./provider.js");
    const emitter = new EventEmitter();
    clientGetPluginMock.mockImplementation((name: string) =>
      name === "gateway" ? { emitter, disconnect: vi.fn() } : undefined,
    );
    clientFetchUserMock.mockImplementationOnce(async () => {
      emitter.emit("error", new Error("Fatal Gateway error: 4014"));
      return { id: "bot-1" };
    });

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    expect(monitorLifecycleMock).toHaveBeenCalledTimes(1);
    const lifecycleArgs = monitorLifecycleMock.mock.calls[0]?.[0] as {
      pendingGatewayErrors?: unknown[];
    };
    expect(lifecycleArgs.pendingGatewayErrors).toHaveLength(1);
    expect(String(lifecycleArgs.pendingGatewayErrors?.[0])).toContain("4014");
  });
});
