import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderAuthMethod, ProviderPlugin } from "../plugins/types.js";
import type { WizardPrompter } from "../wizard/prompts.js";

type AuthMockParams = {
  config: OpenClawConfig;
  prompter: WizardPrompter;
  openUrl: (url: string) => Promise<void>;
};

const resolvePluginProvidersMock = vi.hoisted(() => vi.fn());
const resolvePluginSetupRegistryMock = vi.hoisted(() => vi.fn());
const runProviderPluginAuthMethodMock = vi.hoisted(() => vi.fn());
const runProviderModelSelectedHookMock = vi.hoisted(() => vi.fn());
const updateConfigMock = vi.hoisted(() => vi.fn());

vi.mock("../plugins/providers.runtime.js", () => ({
  resolvePluginProviders: resolvePluginProvidersMock,
}));

vi.mock("../plugins/setup-registry.js", () => ({
  resolvePluginSetupRegistry: resolvePluginSetupRegistryMock,
}));

vi.mock("../plugins/provider-auth-choice.js", () => ({
  runProviderPluginAuthMethod: runProviderPluginAuthMethodMock,
}));

vi.mock("../plugins/provider-wizard.js", () => ({
  runProviderModelSelectedHook: runProviderModelSelectedHookMock,
}));

vi.mock("../commands/models/shared.js", () => ({
  updateConfig: updateConfigMock,
}));

const apiKeyMethod: ProviderAuthMethod = {
  id: "api-key",
  label: "API key",
  kind: "api_key",
  run: async () => ({ profiles: [] }),
};

const oauthMethod: ProviderAuthMethod = {
  id: "oauth",
  label: "OAuth",
  kind: "oauth",
  run: async () => ({ profiles: [] }),
};

function buildProvider(auth: ProviderAuthMethod[] = [apiKeyMethod]): ProviderPlugin {
  return {
    id: "test-provider",
    pluginId: "test-provider",
    label: "Test Provider",
    auth,
  };
}

function buildConfig(configWrites = true): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: "anthropic/claude-sonnet-4-6",
      },
    },
    channels: {
      telegram: {
        allowFrom: ["owner"],
        configWrites,
      },
    },
    models: {
      providers: {
        anthropic: {
          baseUrl: "https://api.anthropic.com/v1",
          models: [],
        },
      },
    },
  };
}

function commandParams(params: {
  commandBody: string;
  cfg?: OpenClawConfig;
  senderIsOwner?: boolean;
  isAuthorizedSender?: boolean;
  isGroup?: boolean;
}) {
  return {
    cfg: params.cfg ?? buildConfig(),
    commandBody: params.commandBody,
    channel: "telegram",
    accountId: "primary",
    conversationId: "telegram:owner-dm",
    senderId: "owner",
    senderIsOwner: params.senderIsOwner ?? true,
    isAuthorizedSender: params.isAuthorizedSender ?? true,
    isGroup: params.isGroup ?? false,
    workspaceDir: "/tmp/openclaw",
  };
}

function telegramButtons(reply: ReplyPayload) {
  const telegramData = reply.channelData?.telegram as
    | { buttons?: Array<Array<{ text: string; callback_data?: string; url?: string }>> }
    | undefined;
  return telegramData?.buttons ?? [];
}

function callbackData(reply: ReplyPayload, row: number, column = 0): string {
  const value = telegramButtons(reply)[row]?.[column]?.callback_data;
  expect(value).toBeDefined();
  expect(value?.length).toBeLessThanOrEqual(64);
  return value ?? "";
}

function firstUrl(reply: ReplyPayload): string | undefined {
  return telegramButtons(reply)
    .flat()
    .find((button) => button.url)?.url;
}

describe("Telegram provider setup runtime", () => {
  let provider: ProviderPlugin;
  let sourceConfig: OpenClawConfig;
  let savedConfig: OpenClawConfig | undefined;
  let capturedSecret: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    const runtime = await import("./runtime.js");
    runtime.__testing.clearProviderSetupSessions();
    provider = buildProvider();
    sourceConfig = buildConfig();
    savedConfig = undefined;
    capturedSecret = undefined;
    resolvePluginProvidersMock.mockReturnValue([provider]);
    resolvePluginSetupRegistryMock.mockReturnValue({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    });
    runProviderPluginAuthMethodMock.mockImplementation(async (params: AuthMockParams) => {
      capturedSecret = await params.prompter.text({
        message: "Paste the API key",
        sensitive: true,
        validate: (value) => (value.startsWith("sk-") ? undefined : "Invalid API key"),
      });
      const applyToConfig = (cfg: OpenClawConfig): OpenClawConfig => ({
        ...cfg,
        agents: {
          ...cfg.agents,
          defaults: {
            ...cfg.agents?.defaults,
            model: { primary: "test-provider/model-a" },
          },
        },
        models: {
          ...cfg.models,
          providers: {
            ...cfg.models?.providers,
            "test-provider": {
              baseUrl: "https://api.test-provider.example/v1",
              models: [],
            },
          },
        },
      });
      return {
        config: applyToConfig(params.config),
        applyToConfig,
        defaultModel: "test-provider/model-a",
      };
    });
    runProviderModelSelectedHookMock.mockResolvedValue(undefined);
    updateConfigMock.mockImplementation(
      async (mutator: (cfg: OpenClawConfig) => OpenClawConfig | Promise<OpenClawConfig>) => {
        savedConfig = await mutator(structuredClone(sourceConfig));
        return savedConfig;
      },
    );
  });

  it("preserves config changes made while the setup session is open", async () => {
    const { handleProviderSetupCommand, submitProviderSetupTextInput } =
      await import("./runtime.js");
    const sessionConfig = structuredClone(sourceConfig);

    const chooseProvider = await handleProviderSetupCommand(
      commandParams({ commandBody: "/providers start", cfg: sessionConfig }),
    );
    const confirmAuth = await handleProviderSetupCommand(
      commandParams({ commandBody: callbackData(chooseProvider!, 0), cfg: sessionConfig }),
    );
    await handleProviderSetupCommand(
      commandParams({ commandBody: callbackData(confirmAuth!, 0), cfg: sessionConfig }),
    );
    const afterSecret = await submitProviderSetupTextInput({
      channel: "telegram",
      accountId: "primary",
      conversationId: "telegram:owner-dm",
      senderId: "owner",
      text: "sk-test",
    });

    sourceConfig = {
      ...sourceConfig,
      agents: {
        ...sourceConfig.agents,
        defaults: {
          ...sourceConfig.agents?.defaults,
          models: {
            "anthropic/claude-sonnet-4-6": {},
          },
        },
      },
    };

    await handleProviderSetupCommand(
      commandParams({ commandBody: callbackData(afterSecret.reply!, 0), cfg: sessionConfig }),
    );

    expect(savedConfig?.agents?.defaults?.models?.["anthropic/claude-sonnet-4-6"]).toEqual({});
    expect(savedConfig?.agents?.defaults?.models?.["test-provider/model-a"]).toEqual({});
    expect(savedConfig?.models?.providers?.["test-provider"]?.baseUrl).toBe(
      "https://api.test-provider.example/v1",
    );
    expect(savedConfig?.plugins?.entries?.["test-provider"]?.enabled).toBe(true);
  });

  it("renders an owner-only private dashboard", async () => {
    const { handleProviderSetupCommand } = await import("./runtime.js");

    const reply = await handleProviderSetupCommand(commandParams({ commandBody: "/providers" }));

    expect(reply?.text).toContain("Model providers");
    expect(reply?.text).toContain("Default: anthropic/claude-sonnet-4-6");
    expect(reply?.text).toContain("Configured: anthropic");
    expect(callbackData(reply!, 0)).toMatch(/^\/providers c [a-f0-9]{16}$/u);
  });

  it("expires unused dashboard callbacks", async () => {
    vi.useFakeTimers();
    try {
      const { __testing, handleProviderSetupCommand } = await import("./runtime.js");

      await handleProviderSetupCommand(commandParams({ commandBody: "/providers" }));
      expect(__testing.providerSetupCallbackCount()).toBe(2);

      vi.advanceTimersByTime(10 * 60 * 1000 + 1);
      await handleProviderSetupCommand(commandParams({ commandBody: "/providers" }));

      expect(__testing.providerSetupCallbackCount()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires abandoned text prompts before consuming later DMs", async () => {
    vi.useFakeTimers();
    try {
      const { __testing, handleProviderSetupCommand, submitProviderSetupTextInput } =
        await import("./runtime.js");

      const chooseProvider = await handleProviderSetupCommand(
        commandParams({ commandBody: "/providers start", cfg: sourceConfig }),
      );
      const confirmAuth = await handleProviderSetupCommand(
        commandParams({ commandBody: callbackData(chooseProvider!, 0), cfg: sourceConfig }),
      );
      const secretPrompt = await handleProviderSetupCommand(
        commandParams({ commandBody: callbackData(confirmAuth!, 0), cfg: sourceConfig }),
      );

      expect(secretPrompt?.text).toContain("Paste the API key");

      vi.advanceTimersByTime(10 * 60 * 1000 + 1);
      const laterDm = await submitProviderSetupTextInput({
        channel: "telegram",
        accountId: "primary",
        conversationId: "telegram:owner-dm",
        senderId: "owner",
        text: "normal later dm",
      });

      expect(laterDm).toEqual({ handled: false });
      expect(capturedSecret).toBeUndefined();
      expect(__testing.providerSetupSessionCount()).toBe(0);
      expect(__testing.providerSetupCallbackCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses unauthorized senders, groups, and configWrites-disabled mutation", async () => {
    const { handleProviderSetupCommand } = await import("./runtime.js");

    const unauthorized = await handleProviderSetupCommand(
      commandParams({
        commandBody: "/providers",
        senderIsOwner: false,
        isAuthorizedSender: false,
      }),
    );
    expect(unauthorized?.text).toBe("Provider setup is only available to the Telegram owner.");

    const group = await handleProviderSetupCommand(
      commandParams({
        commandBody: "/providers start",
        isGroup: true,
      }),
    );
    expect(group?.text).toBe("Provider setup is only available in a private Telegram DM.");

    const readOnly = await handleProviderSetupCommand(
      commandParams({
        commandBody: "/providers start",
        cfg: buildConfig(false),
      }),
    );
    expect(readOnly?.text).toContain("read-only");
    expect(runProviderPluginAuthMethodMock).not.toHaveBeenCalled();
  });

  it("does not run setup auth for provider plugins blocked by config policy", async () => {
    const { handleProviderSetupCommand } = await import("./runtime.js");
    resolvePluginProvidersMock.mockReturnValue([]);
    resolvePluginSetupRegistryMock.mockReturnValue({
      providers: [{ pluginId: "test-provider", provider }],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    });

    const reply = await handleProviderSetupCommand(
      commandParams({
        commandBody: "/providers start",
        cfg: {
          ...sourceConfig,
          plugins: { allow: ["other-provider"] },
        },
      }),
    );

    expect(reply?.text).toContain("No setup-capable model providers are available.");
    expect(runProviderPluginAuthMethodMock).not.toHaveBeenCalled();
  });

  it("keeps text prompts open after provider validation errors", async () => {
    const { __testing, handleProviderSetupCommand, submitProviderSetupTextInput } =
      await import("./runtime.js");

    const chooseProvider = await handleProviderSetupCommand(
      commandParams({ commandBody: "/providers start", cfg: sourceConfig }),
    );
    const confirmAuth = await handleProviderSetupCommand(
      commandParams({ commandBody: callbackData(chooseProvider!, 0), cfg: sourceConfig }),
    );
    await handleProviderSetupCommand(
      commandParams({ commandBody: callbackData(confirmAuth!, 0), cfg: sourceConfig }),
    );

    const invalid = await submitProviderSetupTextInput({
      channel: "telegram",
      accountId: "primary",
      conversationId: "telegram:owner-dm",
      senderId: "owner",
      text: "not-a-key",
    });

    expect(invalid.handled).toBe(true);
    expect(invalid.deleteInputMessage).toBe(true);
    expect(invalid.reply?.text).toContain("Invalid API key");
    expect(invalid.reply?.text).toContain("Paste the API key");
    expect(capturedSecret).toBeUndefined();
    expect(__testing.providerSetupSessionCount()).toBe(1);
  });

  it("runs API-key setup through private text input and saves after confirmation", async () => {
    const { __testing, handleProviderSetupCommand, submitProviderSetupTextInput } =
      await import("./runtime.js");
    runProviderModelSelectedHookMock.mockImplementationOnce(
      async ({ config }: { config: OpenClawConfig }) => {
        const providerConfig = config.models?.providers?.["test-provider"];
        if (providerConfig) {
          providerConfig.baseUrl = "https://hooked.test-provider.example/v1";
        }
      },
    );

    const chooseProvider = await handleProviderSetupCommand(
      commandParams({ commandBody: "/providers start", cfg: sourceConfig }),
    );
    expect(chooseProvider?.text).toBe("Choose provider");
    const providerCallback = callbackData(chooseProvider!, 0);
    expect(providerCallback).toMatch(/^\/providers c [a-f0-9]{16}$/u);

    const confirmAuth = await handleProviderSetupCommand(
      commandParams({ commandBody: providerCallback, cfg: sourceConfig }),
    );
    expect(confirmAuth?.text).toContain("Continue with Test Provider API key?");
    const staleDeclineCallback = callbackData(confirmAuth!, 0, 1);

    const secretPrompt = await handleProviderSetupCommand(
      commandParams({ commandBody: callbackData(confirmAuth!, 0), cfg: sourceConfig }),
    );
    expect(secretPrompt?.text).toContain("Paste the API key");
    expect(secretPrompt?.text).toContain("delete the message");
    const staleDecline = await handleProviderSetupCommand(
      commandParams({ commandBody: staleDeclineCallback, cfg: sourceConfig }),
    );
    expect(staleDecline?.text).toContain("expired");

    const afterSecret = await submitProviderSetupTextInput({
      channel: "telegram",
      accountId: "primary",
      conversationId: "telegram:owner-dm",
      senderId: "owner",
      text: "sk-test",
    });
    expect(afterSecret.handled).toBe(true);
    expect(afterSecret.deleteInputMessage).toBe(true);
    expect(capturedSecret).toBe("sk-test");
    expect(afterSecret.reply?.text).toContain("Set test-provider/model-a as the default model?");

    const saved = await handleProviderSetupCommand(
      commandParams({ commandBody: callbackData(afterSecret.reply!, 0), cfg: sourceConfig }),
    );
    expect(saved?.text).toContain("Test Provider is ready.");
    expect(savedConfig?.agents?.defaults?.model).toEqual({ primary: "test-provider/model-a" });
    expect(savedConfig?.models?.providers?.["test-provider"]?.baseUrl).toBe(
      "https://hooked.test-provider.example/v1",
    );
    expect(savedConfig?.plugins?.entries?.["test-provider"]?.enabled).toBe(true);
    expect(runProviderModelSelectedHookMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: savedConfig,
        model: "test-provider/model-a",
        workspaceDir: "/tmp/openclaw",
      }),
    );
    expect(
      telegramButtons(saved!)
        .flat()
        .map((button) => button.text),
    ).not.toContain("Cancel");

    const complete = await handleProviderSetupCommand(
      commandParams({ commandBody: callbackData(saved!, 0), cfg: sourceConfig }),
    );
    expect(complete?.text).toBe("Provider setup complete.");
    expect(__testing.providerSetupSessionCount()).toBe(0);
  });

  it("keeps the current default model when setup declines the provider default", async () => {
    const { handleProviderSetupCommand, submitProviderSetupTextInput } =
      await import("./runtime.js");

    const chooseProvider = await handleProviderSetupCommand(
      commandParams({ commandBody: "/providers start", cfg: sourceConfig }),
    );
    const confirmAuth = await handleProviderSetupCommand(
      commandParams({ commandBody: callbackData(chooseProvider!, 0), cfg: sourceConfig }),
    );
    const secretPrompt = await handleProviderSetupCommand(
      commandParams({ commandBody: callbackData(confirmAuth!, 0), cfg: sourceConfig }),
    );
    expect(secretPrompt?.text).toContain("Paste the API key");

    const afterSecret = await submitProviderSetupTextInput({
      channel: "telegram",
      accountId: "primary",
      conversationId: "telegram:owner-dm",
      senderId: "owner",
      text: "sk-test",
    });

    const saved = await handleProviderSetupCommand(
      commandParams({ commandBody: callbackData(afterSecret.reply!, 0, 1), cfg: sourceConfig }),
    );

    expect(saved?.text).toContain("Test Provider is ready.");
    expect(savedConfig?.agents?.defaults?.model).toBe("anthropic/claude-sonnet-4-6");
    expect(savedConfig?.plugins?.entries?.["test-provider"]?.enabled).toBe(true);
  });

  it("renders OAuth URLs as URL buttons before continuation", async () => {
    const { handleProviderSetupCommand } = await import("./runtime.js");
    provider = buildProvider([oauthMethod]);
    resolvePluginProvidersMock.mockReturnValue([provider]);
    runProviderPluginAuthMethodMock.mockImplementation(async (params: AuthMockParams) => {
      await params.openUrl("https://login.example.test/device");
      return {
        config: params.config,
        defaultModel: "test-provider/model-a",
      };
    });

    const chooseProvider = await handleProviderSetupCommand(
      commandParams({ commandBody: "/providers start", cfg: sourceConfig }),
    );
    const confirmAuth = await handleProviderSetupCommand(
      commandParams({ commandBody: callbackData(chooseProvider!, 0), cfg: sourceConfig }),
    );
    const login = await handleProviderSetupCommand(
      commandParams({ commandBody: callbackData(confirmAuth!, 0), cfg: sourceConfig }),
    );

    expect(login?.text).toContain("https://login.example.test/device");
    expect(firstUrl(login!)).toBe("https://login.example.test/device");
  });

  it("expires old callbacks when a concurrent setup starts", async () => {
    const { __testing, handleProviderSetupCommand } = await import("./runtime.js");

    const first = await handleProviderSetupCommand(
      commandParams({ commandBody: "/providers start", cfg: sourceConfig }),
    );
    const firstCallback = callbackData(first!, 0);
    await handleProviderSetupCommand(
      commandParams({ commandBody: "/providers start", cfg: sourceConfig }),
    );

    const expired = await handleProviderSetupCommand(
      commandParams({ commandBody: firstCallback, cfg: sourceConfig }),
    );
    expect(expired?.text).toContain("expired");
    expect(__testing.providerSetupSessionCount()).toBe(1);
  });
});
