import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { Mock } from "vitest";
import { expect, vi } from "vitest";
import type { OpenClawConfig } from "../../../extensions/discord/src/runtime-api.js";

export type NativeCommandSpecMock = {
  name: string;
  description: string;
  acceptsArgs: boolean;
};

export type PluginCommandSpecMock = {
  name: string;
  description: string;
  acceptsArgs: boolean;
};

type ProviderMonitorTestMocks = {
  clientHandleDeployRequestMock: Mock<() => Promise<void>>;
  clientFetchUserMock: Mock<(target: string) => Promise<{ id: string }>>;
  clientGetPluginMock: Mock<(name: string) => unknown>;
  clientConstructorOptionsMock: Mock<(options?: unknown) => void>;
  createDiscordAutoPresenceControllerMock: Mock<() => unknown>;
  createDiscordNativeCommandMock: Mock<(params?: { command?: { name?: string } }) => unknown>;
  createDiscordMessageHandlerMock: Mock<() => unknown>;
  createNoopThreadBindingManagerMock: Mock<() => { stop: ReturnType<typeof vi.fn> }>;
  createThreadBindingManagerMock: Mock<() => { stop: ReturnType<typeof vi.fn> }>;
  reconcileAcpThreadBindingsOnStartupMock: Mock<() => unknown>;
  createdBindingManagers: Array<{ stop: ReturnType<typeof vi.fn> }>;
  getAcpSessionStatusMock: Mock<
    (params: {
      cfg: OpenClawConfig;
      sessionKey: string;
      signal?: AbortSignal;
    }) => Promise<{ state: string }>
  >;
  getPluginCommandSpecsMock: Mock<(provider?: string) => PluginCommandSpecMock[]>;
  listNativeCommandSpecsForConfigMock: Mock<
    (
      cfg?: unknown,
      params?: { skillCommands?: unknown[]; provider?: string },
    ) => NativeCommandSpecMock[]
  >;
  listSkillCommandsForAgentsMock: Mock<
    (params?: { cfg?: unknown; agentIds?: string[] }) => unknown[]
  >;
  monitorLifecycleMock: Mock<(params: { threadBindings: { stop: () => void } }) => Promise<void>>;
  rememberDiscordManagedBotIdentityMock: Mock<() => void>;
  resolveDiscordAccountMock: Mock<() => unknown>;
  resolveDiscordAllowlistConfigMock: Mock<() => Promise<unknown>>;
  forgetDiscordManagedBotIdentityMock: Mock<() => void>;
  resolveNativeCommandsEnabledMock: Mock<() => boolean>;
  resolveNativeSkillsEnabledMock: Mock<() => boolean>;
  isVerboseMock: Mock<() => boolean>;
  shouldLogVerboseMock: Mock<() => boolean>;
  voiceRuntimeModuleLoadedMock: Mock<() => void>;
};

export function baseDiscordAccountConfig() {
  return {
    commands: { native: true, nativeSkills: false },
    voice: { enabled: false },
    agentComponents: { enabled: false },
    execApprovals: { enabled: false },
  };
}

const providerMonitorTestMocks: ProviderMonitorTestMocks = vi.hoisted(() => {
  const createdBindingManagers: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
  const isVerboseMock = vi.fn(() => false);
  const shouldLogVerboseMock = vi.fn(() => false);

  return {
    clientHandleDeployRequestMock: vi.fn(async () => undefined),
    clientFetchUserMock: vi.fn(async (_target: string) => ({ id: "bot-1" })),
    clientGetPluginMock: vi.fn<(_name: string) => unknown>(() => undefined),
    clientConstructorOptionsMock: vi.fn(),
    createDiscordAutoPresenceControllerMock: vi.fn(() => ({
      enabled: false,
      start: vi.fn(),
      stop: vi.fn(),
      refresh: vi.fn(),
      runNow: vi.fn(),
    })),
    createDiscordNativeCommandMock: vi.fn((params?: { command?: { name?: string } }) => ({
      name: params?.command?.name ?? "mock-command",
    })),
    createDiscordMessageHandlerMock: vi.fn(() =>
      Object.assign(
        vi.fn(async () => undefined),
        {
          deactivate: vi.fn(),
          waitForIdle: vi.fn(async () => undefined),
        },
      ),
    ),
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
    getAcpSessionStatusMock: vi.fn(
      async (_params: { cfg: OpenClawConfig; sessionKey: string; signal?: AbortSignal }) => ({
        state: "idle",
      }),
    ),
    getPluginCommandSpecsMock: vi.fn<(provider?: string) => PluginCommandSpecMock[]>(() => []),
    listNativeCommandSpecsForConfigMock: vi.fn<
      (
        cfg?: unknown,
        params?: { skillCommands?: unknown[]; provider?: string },
      ) => NativeCommandSpecMock[]
    >(() => [{ name: "cmd", description: "built-in", acceptsArgs: false }]),
    listSkillCommandsForAgentsMock: vi.fn<
      (params?: { cfg?: unknown; agentIds?: string[] }) => unknown[]
    >(() => []),
    monitorLifecycleMock: vi.fn(async (params: { threadBindings: { stop: () => void } }) => {
      params.threadBindings.stop();
    }),
    rememberDiscordManagedBotIdentityMock: vi.fn(),
    resolveDiscordAccountMock: vi.fn(() => ({
      accountId: "default",
      token: "cfg-token",
      config: baseDiscordAccountConfig(),
    })),
    resolveDiscordAllowlistConfigMock: vi.fn(async () => ({
      guildEntries: undefined,
      allowFrom: undefined,
    })),
    forgetDiscordManagedBotIdentityMock: vi.fn(),
    resolveNativeCommandsEnabledMock: vi.fn(() => true),
    resolveNativeSkillsEnabledMock: vi.fn(() => false),
    isVerboseMock,
    shouldLogVerboseMock,
    voiceRuntimeModuleLoadedMock: vi.fn(),
  };
});

const {
  clientHandleDeployRequestMock,
  clientFetchUserMock,
  clientGetPluginMock,
  clientConstructorOptionsMock,
  createDiscordAutoPresenceControllerMock,
  createDiscordNativeCommandMock,
  createDiscordMessageHandlerMock,
  createNoopThreadBindingManagerMock,
  createThreadBindingManagerMock,
  reconcileAcpThreadBindingsOnStartupMock,
  createdBindingManagers,
  getAcpSessionStatusMock,
  getPluginCommandSpecsMock,
  listNativeCommandSpecsForConfigMock,
  listSkillCommandsForAgentsMock,
  monitorLifecycleMock,
  rememberDiscordManagedBotIdentityMock,
  resolveDiscordAccountMock,
  resolveDiscordAllowlistConfigMock,
  forgetDiscordManagedBotIdentityMock,
  resolveNativeCommandsEnabledMock,
  resolveNativeSkillsEnabledMock,
  isVerboseMock,
  shouldLogVerboseMock,
  voiceRuntimeModuleLoadedMock,
} = providerMonitorTestMocks;

export function getProviderMonitorTestMocks(): typeof providerMonitorTestMocks {
  return providerMonitorTestMocks;
}

export function mockResolvedDiscordAccountConfig(overrides: Record<string, unknown>) {
  resolveDiscordAccountMock.mockImplementation(() => ({
    accountId: "default",
    token: "cfg-token",
    config: {
      ...baseDiscordAccountConfig(),
      ...overrides,
    },
  }));
}

export function getFirstDiscordMessageHandlerParams<T extends object>() {
  expect(createDiscordMessageHandlerMock).toHaveBeenCalledTimes(1);
  const firstCall = createDiscordMessageHandlerMock.mock.calls.at(0) as [T] | undefined;
  return firstCall?.[0];
}

export function resetDiscordProviderMonitorMocks(params?: {
  nativeCommands?: NativeCommandSpecMock[];
}) {
  clientHandleDeployRequestMock.mockClear().mockResolvedValue(undefined);
  clientFetchUserMock.mockClear().mockResolvedValue({ id: "bot-1" });
  clientGetPluginMock.mockClear().mockReturnValue(undefined);
  clientConstructorOptionsMock.mockClear();
  createDiscordAutoPresenceControllerMock.mockClear().mockImplementation(() => ({
    enabled: false,
    start: vi.fn(),
    stop: vi.fn(),
    refresh: vi.fn(),
    runNow: vi.fn(),
  }));
  createDiscordNativeCommandMock.mockClear().mockImplementation((input) => ({
    name: input?.command?.name ?? "mock-command",
  }));
  createDiscordMessageHandlerMock.mockClear().mockImplementation(() =>
    Object.assign(
      vi.fn(async () => undefined),
      {
        deactivate: vi.fn(),
        waitForIdle: vi.fn(async () => undefined),
      },
    ),
  );
  createNoopThreadBindingManagerMock.mockClear();
  createThreadBindingManagerMock.mockClear();
  reconcileAcpThreadBindingsOnStartupMock.mockClear().mockReturnValue({
    checked: 0,
    removed: 0,
    staleSessionKeys: [],
  });
  createdBindingManagers.length = 0;
  getAcpSessionStatusMock.mockClear().mockResolvedValue({ state: "idle" });
  getPluginCommandSpecsMock.mockClear().mockReturnValue([]);
  listNativeCommandSpecsForConfigMock
    .mockClear()
    .mockReturnValue(
      params?.nativeCommands ?? [{ name: "cmd", description: "built-in", acceptsArgs: false }],
    );
  listSkillCommandsForAgentsMock.mockClear().mockReturnValue([]);
  monitorLifecycleMock.mockClear().mockImplementation(async (monitorParams) => {
    monitorParams.threadBindings.stop();
  });
  rememberDiscordManagedBotIdentityMock.mockClear();
  resolveDiscordAccountMock.mockClear().mockReturnValue({
    accountId: "default",
    token: "cfg-token",
    config: baseDiscordAccountConfig(),
  });
  resolveDiscordAllowlistConfigMock.mockClear().mockResolvedValue({
    guildEntries: undefined,
    allowFrom: undefined,
  });
  forgetDiscordManagedBotIdentityMock.mockClear();
  resolveNativeCommandsEnabledMock.mockClear().mockReturnValue(true);
  resolveNativeSkillsEnabledMock.mockClear().mockReturnValue(false);
  isVerboseMock.mockClear().mockReturnValue(false);
  shouldLogVerboseMock.mockClear().mockReturnValue(false);
  voiceRuntimeModuleLoadedMock.mockClear();
}

export const baseRuntime = (): RuntimeEnv => ({
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
});

export const baseConfig = (): OpenClawConfig =>
  ({
    channels: {
      discord: {
        accounts: {
          default: {},
        },
      },
    },
  }) as OpenClawConfig;

vi.mock("@buape/carbon", () => {
  class Button {}
  class ChannelSelectMenu {}
  class Command {}
  class CommandWithSubcommands {}
  class Container {
    constructor(
      _components?: unknown,
      _options?: {
        accentColor?: string;
        spoiler?: boolean;
      },
    ) {}
  }
  class MentionableSelectMenu {}
  class Message {}
  class MessageCreateListener {}
  class MessageReactionAddListener {}
  class MessageReactionRemoveListener {}
  class Modal {}
  class PresenceUpdateListener {}
  class ReadyListener {}
  class RateLimitError extends Error {
    status = 429;
    discordCode?: number;
    retryAfter: number;
    scope: string | null;
    bucket: string | null;
    constructor(
      response: Response,
      body: { message: string; retry_after: number; global: boolean },
    ) {
      super(body.message);
      this.retryAfter = body.retry_after;
      this.scope = body.global ? "global" : response.headers.get("X-RateLimit-Scope");
      this.bucket = response.headers.get("X-RateLimit-Bucket");
    }
  }
  class Client {
    listeners: unknown[];
    rest: { put: ReturnType<typeof vi.fn> };
    options: unknown;
    constructor(options: unknown, handlers: { listeners?: unknown[] }) {
      this.options = options;
      this.listeners = handlers.listeners ?? [];
      this.rest = { put: vi.fn(async () => undefined) };
      clientConstructorOptionsMock(options);
    }
    async handleDeployRequest() {
      return await clientHandleDeployRequestMock();
    }
    async fetchUser(target: string) {
      return await clientFetchUserMock(target);
    }
    getPlugin(name: string) {
      return clientGetPluginMock(name);
    }
  }
  class RequestClient {}
  class Row {}
  class RoleSelectMenu {}
  class Separator {}
  class StringSelectMenu {}
  class TextDisplay {}
  class ThreadUpdateListener {}
  class UserSelectMenu {}
  class Embed {}
  const ChannelType = {
    GuildText: 0,
    DM: 1,
    GuildVoice: 2,
    GroupDM: 3,
    GuildCategory: 4,
    GuildAnnouncement: 5,
    AnnouncementThread: 10,
    PublicThread: 11,
    PrivateThread: 12,
  };
  const MessageType = {
    Default: 0,
    Reply: 19,
  };
  class CheckboxGroup {}
  class File {}
  class Label {}
  class LinkButton {}
  class MediaGallery {}
  class RadioGroup {}
  class Section {}
  class TextInput {}
  class Thumbnail {}
  const parseCustomId = (_id: string) => ({ baseId: _id });
  return {
    Client,
    Button,
    ChannelSelectMenu,
    ChannelType,
    CheckboxGroup,
    Command,
    CommandWithSubcommands,
    Container,
    Embed,
    File,
    Label,
    LinkButton,
    MediaGallery,
    MentionableSelectMenu,
    Message,
    MessageCreateListener,
    MessageType,
    MessageReactionAddListener,
    MessageReactionRemoveListener,
    Modal,
    PresenceUpdateListener,
    RadioGroup,
    RateLimitError,
    ReadyListener,
    RequestClient,
    Row,
    RoleSelectMenu,
    Section,
    Separator,
    serializePayload: (payload: unknown) => payload,
    StringSelectMenu,
    TextDisplay,
    TextInput,
    ThreadUpdateListener,
    Thumbnail,
    UserSelectMenu,
    parseCustomId,
  };
});

vi.mock("@buape/carbon/gateway", () => {
  class GatewayPlugin {
    gatewayInfo?: unknown;
    constructor(_options?: unknown) {}
    async registerClient(_client: unknown) {
      return undefined;
    }
  }
  return {
    GatewayCloseCodes: { DisallowedIntents: 4014 },
    GatewayIntents: {
      Guilds: 1 << 0,
      GuildMessages: 1 << 9,
      MessageContent: 1 << 15,
      DirectMessages: 1 << 12,
      GuildMessageReactions: 1 << 10,
      DirectMessageReactions: 1 << 13,
      GuildVoiceStates: 1 << 7,
      GuildPresences: 1 << 8,
      GuildMembers: 1 << 1,
    },
    GatewayPlugin,
  };
});

vi.mock("@buape/carbon/voice", () => {
  return {
    VoicePlugin: class VoicePlugin {},
  };
});

vi.mock("openclaw/plugin-sdk/acp-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/acp-runtime")>(
    "openclaw/plugin-sdk/acp-runtime",
  );
  return {
    ...actual,
    getAcpSessionManager: () => ({
      getSessionStatus: getAcpSessionStatusMock,
    }),
    isAcpRuntimeError: (error: unknown): error is { code: string } =>
      error instanceof Error && "code" in error,
  };
});

vi.mock("openclaw/plugin-sdk/command-auth", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/command-auth")>(
    "openclaw/plugin-sdk/command-auth",
  );
  return {
    ...actual,
    listNativeCommandSpecsForConfig: listNativeCommandSpecsForConfigMock,
    listSkillCommandsForAgents: listSkillCommandsForAgentsMock,
  };
});
vi.mock("openclaw/plugin-sdk/reply-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-runtime")>(
    "openclaw/plugin-sdk/reply-runtime",
  );
  return {
    ...actual,
    resolveTextChunkLimit: () => 2000,
  };
});

vi.mock("openclaw/plugin-sdk/config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/config-runtime")>(
    "openclaw/plugin-sdk/config-runtime",
  );
  return {
    ...actual,
    isNativeCommandsExplicitlyDisabled: () => false,
    loadConfig: () => ({}),
    resolveNativeCommandsEnabled: resolveNativeCommandsEnabledMock,
    resolveNativeSkillsEnabled: resolveNativeSkillsEnabledMock,
  };
});

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    danger: (value: string) => value,
    isVerbose: isVerboseMock,
    logVerbose: vi.fn(),
    shouldLogVerbose: shouldLogVerboseMock,
    warn: (value: string) => value,
    createSubsystemLogger: () => {
      const logger = {
        child: vi.fn(() => logger),
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      };
      return logger;
    },
    createNonExitingRuntime: () => ({ log: vi.fn(), error: vi.fn(), exit: vi.fn() }),
  };
});

vi.mock("openclaw/plugin-sdk/infra-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/infra-runtime")>(
    "openclaw/plugin-sdk/infra-runtime",
  );
  return {
    ...actual,
    formatErrorMessage: (error: unknown) => String(error),
  };
});

vi.mock("../../../extensions/discord/src/accounts.js", () => ({
  forgetDiscordManagedBotIdentity: forgetDiscordManagedBotIdentityMock,
  rememberDiscordManagedBotIdentity: rememberDiscordManagedBotIdentityMock,
  resolveDiscordAccount: resolveDiscordAccountMock,
}));

vi.mock("../../../extensions/discord/src/probe.js", () => ({
  fetchDiscordApplicationId: async () => "app-1",
}));

vi.mock("../../../extensions/discord/src/token.js", () => ({
  normalizeDiscordToken: (value?: string) => value,
}));

vi.mock("../../../extensions/discord/src/voice/command.js", () => ({
  createDiscordVoiceCommand: () => ({ name: "voice-command" }),
}));

vi.mock("../../../extensions/discord/src/monitor/agent-components.js", () => ({
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

vi.mock("../../../extensions/discord/src/monitor/auto-presence.js", () => ({
  createDiscordAutoPresenceController: createDiscordAutoPresenceControllerMock,
}));

vi.mock("../../../extensions/discord/src/monitor/commands.js", () => ({
  resolveDiscordSlashCommandConfig: () => ({ ephemeral: false }),
}));

vi.mock("../../../extensions/discord/src/monitor/exec-approvals.js", () => ({
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

vi.mock("../../../extensions/discord/src/monitor/gateway-plugin.js", () => ({
  createDiscordGatewayPlugin: () => ({ id: "gateway-plugin" }),
}));

vi.mock("../../../extensions/discord/src/monitor/listeners.js", () => ({
  DiscordMessageListener: class DiscordMessageListener {},
  DiscordPresenceListener: class DiscordPresenceListener {},
  DiscordReactionListener: class DiscordReactionListener {},
  DiscordReactionRemoveListener: class DiscordReactionRemoveListener {},
  DiscordThreadUpdateListener: class DiscordThreadUpdateListener {},
  registerDiscordListener: vi.fn(),
}));

vi.mock("../../../extensions/discord/src/monitor/message-handler.js", () => ({
  createDiscordMessageHandler: createDiscordMessageHandlerMock,
}));

vi.mock("../../../extensions/discord/src/monitor/native-command.js", () => ({
  createDiscordCommandArgFallbackButton: () => ({ id: "arg-fallback" }),
  createDiscordModelPickerFallbackButton: () => ({ id: "model-fallback-btn" }),
  createDiscordModelPickerFallbackSelect: () => ({ id: "model-fallback-select" }),
  createDiscordNativeCommand: createDiscordNativeCommandMock,
}));

vi.mock("../../../extensions/discord/src/monitor/presence.js", () => ({
  resolveDiscordPresenceUpdate: () => undefined,
}));

vi.mock("../../../extensions/discord/src/monitor/provider.allowlist.js", () => ({
  resolveDiscordAllowlistConfig: resolveDiscordAllowlistConfigMock,
}));

vi.mock("../../../extensions/discord/src/monitor/provider.lifecycle.js", () => ({
  runDiscordGatewayLifecycle: monitorLifecycleMock,
}));

vi.mock("../../../extensions/discord/src/monitor/rest-fetch.js", () => ({
  resolveDiscordRestFetch: () => async () => undefined,
}));

vi.mock("../../../extensions/discord/src/monitor/thread-bindings.js", () => ({
  createNoopThreadBindingManager: createNoopThreadBindingManagerMock,
  createThreadBindingManager: createThreadBindingManagerMock,
  reconcileAcpThreadBindingsOnStartup: reconcileAcpThreadBindingsOnStartupMock,
  resolveThreadBindingIdleTimeoutMs: vi.fn(() => 24 * 60 * 60 * 1000),
}));
