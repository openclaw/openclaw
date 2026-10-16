import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import {
  applyLocalSetupWorkspaceConfig,
  applySkipBootstrapConfig,
} from "../commands/onboard-config.js";
import { createTestConfigFileStore } from "../commands/test-runtime-config-helpers.js";
import type { ConfigWriteOptions } from "../config/io.js";
import { resolvePersistCandidateForWrite } from "../config/io.write-prepare.js";
import type { OpenClawConfigWithLegacyRoster } from "../config/legacy.roster.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import { WizardCancelledError, type WizardPrompter } from "./prompts.js";
import { runSetupModelAuthStep, type SetupModelAuthCandidate } from "./setup.model-auth.js";
import {
  requestTelemetryConsent,
  requireRiskAcknowledgement,
  resolveQuickstartGatewayDefaults,
  writeWizardConfigFile,
} from "./setup.shared.js";

type ResolveManifestProviderAuthChoice =
  typeof import("../plugins/provider-auth-choices.js").resolveManifestProviderAuthChoice;
type ResolvePluginSetupProvider =
  typeof import("../plugins/setup-registry.js").resolvePluginSetupProviderCore;

const applyAuthChoice = vi.hoisted(() => vi.fn());
const warnIfModelConfigLooksOff = vi.hoisted(() => vi.fn());
const resolvePreferredProviderForAuthChoice = vi.hoisted(() => vi.fn());
const promptDefaultModel = vi.hoisted(() => vi.fn());
const promptAuthChoiceGrouped = vi.hoisted(() => vi.fn());
const promptCustomApiConfig = vi.hoisted(() => vi.fn());
const ensureAuthProfileStore = vi.hoisted(() => vi.fn(() => ({ profiles: {} })));
const detectAvailableSetupProviderIds = vi.hoisted(() => vi.fn());
const resolveManifestProviderAuthChoice = vi.hoisted(() =>
  vi.fn<ResolveManifestProviderAuthChoice>(() => ({
    pluginId: "anthropic",
    providerId: "anthropic",
    methodId: "anthropic-cli",
    choiceId: "anthropic-cli",
    choiceLabel: "Anthropic CLI",
  })),
);
const resolvePluginSetupProviderCore = vi.hoisted(() =>
  vi.fn<ResolvePluginSetupProvider>(() => undefined),
);

vi.mock("../commands/auth-choice.apply.js", () => ({
  applyAuthChoice,
  prepareAuthChoice: applyAuthChoice,
}));
vi.mock("../commands/auth-choice.model-check.js", () => ({ warnIfModelConfigLooksOff }));
vi.mock("../plugins/provider-auth-choice-preference.js", () => ({
  resolvePreferredProviderForAuthChoice,
}));
vi.mock("../flows/model-picker.js", () => ({ promptDefaultModel }));
vi.mock("../commands/onboard-custom.js", () => ({ promptCustomApiConfig }));
vi.mock("../commands/auth-choice-prompt.js", () => ({
  isKeepCurrentAuthChoice: (value: unknown) => value === "__keep-current",
  promptAuthChoiceGrouped,
}));
vi.mock("../agents/auth-profiles.runtime.js", () => ({ ensureAuthProfileStore }));
vi.mock("../plugins/provider-setup-availability.js", () => ({ detectAvailableSetupProviderIds }));
vi.mock("../plugins/provider-auth-choices.js", () => ({ resolveManifestProviderAuthChoice }));
vi.mock("../plugins/setup-registry.js", () => ({ resolvePluginSetupProviderCore }));

function runStep(params: Partial<Parameters<typeof runSetupModelAuthStep>[0]> = {}) {
  return runSetupModelAuthStep({
    config: {},
    opts: {},
    prompter: createWizardPrompter({ disableBackNavigation: vi.fn() }),
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    ...params,
  });
}

function candidate(
  config: OpenClawConfig,
  authProfiles: SetupModelAuthCandidate["authProfiles"] = [],
) {
  return { config, authProfiles, persistAuthProfiles: vi.fn(async () => {}) };
}

const managedModels: OpenClawConfig["models"] = {
  providers: {
    "managed-local": {
      baseUrl: "http://127.0.0.1:8080/v1",
      models: [],
      localService: { command: "/fixture/server" },
    },
  },
};

function createDefaultAgentConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: { workspace: "/tmp/global-workspace" },
      entries: {
        ops: {
          agentDir: "/tmp/ops-agent",
          workspace: "/tmp/ops-workspace",
        },
      },
    },
  };
}

describe("runSetupModelAuthStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    promptDefaultModel.mockResolvedValue({});
    warnIfModelConfigLooksOff.mockResolvedValue(undefined);
    detectAvailableSetupProviderIds.mockResolvedValue(new Set(["ollama"]));
  });

  it("keeps the migrated setup owner and pending credentials through config copies", async () => {
    const raw: OpenClawConfigWithLegacyRoster = createDefaultAgentConfig();
    raw.agents!.entries = { alpha: {}, ...raw.agents!.entries };
    raw.agents!.entries!.ops!.default = true;
    let config = createCanonicalAgentConfigFixture(raw).config;
    const prompter = createWizardPrompter();
    config = await requireRiskAcknowledgement({ config, opts: { acceptRisk: true }, prompter });
    vi.mocked(prompter.select).mockResolvedValueOnce(false);
    config = await requestTelemetryConsent({ config, opts: {}, prompter });
    config = applySkipBootstrapConfig(applyLocalSetupWorkspaceConfig(config, "/tmp/requested"));
    const prepared = candidate({ ...config }, [
      {
        profileId: "anthropic:default",
        credential: { type: "api_key", provider: "anthropic", key: "test-anthropic-key" },
      },
    ]);
    promptAuthChoiceGrouped.mockResolvedValueOnce("anthropic-cli");
    applyAuthChoice.mockResolvedValueOnce(prepared);

    resolvePluginSetupProviderCore.mockReturnValueOnce({
      id: "anthropic",
      label: "Anthropic",
      auth: [
        {
          id: "anthropic-cli",
          label: "CLI",
          kind: "custom",
          wizard: { modelSelection: { allowKeepCurrent: false } },
          run: vi.fn(async () => ({ profiles: [] })),
        },
      ],
    });
    const result = await runStep({ config, prompter });
    const target = { agentId: "ops", agentDir: "/tmp/ops-agent" };

    expect(ensureAuthProfileStore).not.toHaveBeenCalled();
    expect(promptAuthChoiceGrouped).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/ops-workspace",
        detectedProviderIds: new Set(["ollama"]),
      }),
    );
    expect(applyAuthChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        ...target,
        preserveExistingDefaultModel: true,
      }),
    );
    expect(promptDefaultModel).toHaveBeenCalledWith(
      expect.objectContaining({ ...target, workspaceDir: "/tmp/ops-workspace", allowKeep: false }),
    );
    expect(warnIfModelConfigLooksOff).toHaveBeenCalledWith(expect.anything(), prompter, {
      ...target,
      pendingAuthProfiles: prepared.authProfiles,
    });
    expect(resolvePluginSetupProviderCore).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic", pluginIds: ["anthropic"] }),
    );
    expect(result.persistAuthProfiles).toBe(prepared.persistAuthProfiles);
    expect(prepared.persistAuthProfiles).not.toHaveBeenCalled();
  });

  it("stages provider auth on the pending named agent without nesting its workspace", async () => {
    const workspaceDir = "/tmp/robby-workspace";
    const config: OpenClawConfig = { agents: { defaults: { workspace: workspaceDir } } };
    promptAuthChoiceGrouped.mockResolvedValueOnce("anthropic-cli");
    applyAuthChoice.mockResolvedValueOnce(candidate(config));

    await runStep({ config, pendingAgent: { name: "Robby!", workspaceDir } });

    const agentDir = expect.stringMatching(/[/\\]agents[/\\]robby[/\\]agent$/);
    expect(ensureAuthProfileStore).not.toHaveBeenCalled();
    expect(promptAuthChoiceGrouped).toHaveBeenCalledWith(expect.objectContaining({ workspaceDir }));
    expect(applyAuthChoice).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "robby", agentDir, workspaceDir }),
    );
    expect(promptDefaultModel).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "robby", agentDir, workspaceDir }),
    );
    expect(warnIfModelConfigLooksOff).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ agentId: "robby", agentDir }),
    );
  });

  it("keeps managed model defaults owned by the selected fleet agent", async () => {
    const selectedModel = "managed-local/selected";
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: {
          systemAgent: { agentId: "ops" },
          model: { primary: "global/current" },
          models: { "global/current": { alias: "global" } },
        },
        entries: {
          ops: {
            model: { primary: "ops/current" },
            models: { "ops/current": { alias: "existing" } },
            agentDir: "/tmp/ops-agent",
            workspace: "/tmp/ops-workspace",
          },
          main: { model: { primary: "main/current" } },
        },
      },
    };
    applyAuthChoice.mockImplementationOnce(({ config: authConfig }: { config: OpenClawConfig }) =>
      candidate({
        ...authConfig,
        agents: {
          ...authConfig.agents,
          defaults: {
            ...authConfig.agents?.defaults,
            model: { primary: selectedModel },
            models: {
              ...authConfig.agents?.defaults?.models,
              [selectedModel]: { alias: "selected" },
            },
          },
        },
        models: managedModels,
      }),
    );

    const result = await runStep({ config, opts: { authChoice: "anthropic-cli" } });

    expect(applyAuthChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "ops",
        config: expect.objectContaining({
          agents: expect.objectContaining({
            defaults: expect.objectContaining({
              model: { primary: "ops/current" },
              models: { "ops/current": { alias: "existing" } },
            }),
          }),
        }),
      }),
    );
    expect(result.config.agents?.defaults).toEqual(config.agents?.defaults);
    expect(result.config.agents?.entries?.main).toEqual(config.agents?.entries?.main);
    expect(result.config.agents?.entries?.ops?.model).toEqual({ primary: selectedModel });
    expect(result.config.agents?.entries?.ops?.models).toEqual({
      "ops/current": { alias: "existing" },
      [selectedModel]: { alias: "selected" },
    });
  });

  it("passes the explicit system agent to custom setup while preserving its existing model", async () => {
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "ops" }, model: { primary: "global/current" } },
        entries: { ops: { model: { primary: "ops/current" }, workspace: "/tmp/ops-workspace" } },
      },
    };
    promptCustomApiConfig.mockResolvedValueOnce({ config });

    const result = await runStep({
      config,
      opts: { authChoice: "custom-api-key" },
      preserveExistingModelSelection: true,
    });
    await result.persistAuthProfiles();

    expect(promptCustomApiConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ agentId: "ops", workspaceDir: "/tmp/ops-workspace" }),
        setAsPrimary: false,
      }),
    );
    expect(result.config.agents).toEqual(config.agents);
  });

  it("applies and validates an interactive model selection on the configured agent", async () => {
    const config = createDefaultAgentConfig();
    config.agents!.defaults!.model = "openai/global-model";
    config.agents!.entries!.ops!.model = {
      primary: "anthropic/old-model",
      fallbacks: ["openai/fallback-model"],
    };
    promptAuthChoiceGrouped.mockResolvedValueOnce("skip");
    promptDefaultModel.mockResolvedValueOnce({ model: "google/new-model" });

    const result = await runStep({ config });

    expect(result.config.agents?.entries?.ops?.model).toEqual({
      primary: "google/new-model",
      fallbacks: ["openai/fallback-model"],
    });
    expect(result.config.agents?.defaults?.model).toBe("openai/global-model");
    expect(warnIfModelConfigLooksOff).toHaveBeenCalledWith(result.config, expect.anything(), {
      agentId: "ops",
      agentDir: "/tmp/ops-agent",
    });
  });

  it("keeps the current provider without applying auth or automatic lean changes", async () => {
    const config: OpenClawConfig = { agents: { defaults: { model: "managed-local/model" } } };
    promptAuthChoiceGrouped.mockResolvedValueOnce("__keep-current");
    const result = await runStep({ config });
    expect(result.config).toBe(config);
    expect(applyAuthChoice).not.toHaveBeenCalled();
  });

  it("re-prompts after a provider setup error instead of aborting", async () => {
    promptAuthChoiceGrouped.mockResolvedValueOnce("anthropic-cli").mockResolvedValueOnce("skip");
    applyAuthChoice.mockRejectedValueOnce(
      new Error("Claude CLI is not authenticated on this host."),
    );
    const prompter = createWizardPrompter();
    const result = await runStep({ prompter });
    expect(result).toEqual({
      config: {},
      authProfiles: [],
      persistAuthProfiles: expect.any(Function),
    });
    expect(promptAuthChoiceGrouped).toHaveBeenCalledTimes(2);
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("Claude CLI is not authenticated on this host."),
      "Provider setup failed",
    );
  });

  it("still fails loudly when the auth choice came from a flag", async () => {
    applyAuthChoice.mockRejectedValueOnce(
      new Error("Claude CLI is not authenticated on this host."),
    );
    await expect(runStep({ opts: { authChoice: "anthropic-cli" } })).rejects.toThrow(
      "Claude CLI is not authenticated",
    );
  });

  it("propagates wizard cancellation from provider setup", async () => {
    promptAuthChoiceGrouped.mockResolvedValueOnce("anthropic-cli");
    applyAuthChoice.mockRejectedValueOnce(new WizardCancelledError());
    await expect(runStep()).rejects.toThrow(WizardCancelledError);
  });
});

const configFiles = createTestConfigFileStore();

const mocks = vi.hoisted(() => ({
  currentConfig: {} as OpenClawConfig,
  transformConfigWithPendingPluginInstalls: vi.fn(),
}));

vi.mock("../plugins/install-record-commit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/install-record-commit.js")>()),
  transformConfigWithPendingPluginInstalls: mocks.transformConfigWithPendingPluginInstalls,
}));

describe("requestTelemetryConsent", () => {
  it("records telemetry consent only once", async () => {
    const enabled = true;
    const select = vi.fn(async () => enabled) as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({ select });

    const config = await requestTelemetryConsent({ opts: {}, prompter, config: {} });

    expect(config.telemetry).toEqual({ enabled, consentedAt: expect.any(String) });
    await expect(requestTelemetryConsent({ opts: {}, prompter, config })).resolves.toBe(config);
    expect(select).toHaveBeenCalledOnce();
  });
});

describe("resolveQuickstartGatewayDefaults", () => {
  const storedConfig: OpenClawConfig = {
    gateway: {
      port: 19111,
      bind: "custom",
      customBindHost: "192.0.2.10",
      auth: { mode: "token", token: "stored-token", password: "stored-password" },
      tailscale: { mode: "serve" },
    },
  };

  it.each([
    { credentials: {}, mode: "token" },
    { credentials: { token: "stored-token" }, mode: "token" },
    { credentials: { password: "stored-password" }, mode: "password" },
  ])("retains existing no-auth credential inference: $mode", ({ credentials, mode }) => {
    expect(
      resolveQuickstartGatewayDefaults({ gateway: { auth: { mode: "none", ...credentials } } })
        .authMode,
    ).toBe(mode);
  });

  it("aligns credential-only overrides while keeping an explicit auth mode authoritative", () => {
    const mode = (
      opts: Parameters<typeof resolveQuickstartGatewayDefaults>[1],
      config = storedConfig,
    ) => resolveQuickstartGatewayDefaults(config, opts).authMode;
    expect(mode({ gatewayPassword: "explicit-password" })).toBe("password");
    expect(
      mode(
        { gatewayToken: "explicit-token" },
        {
          gateway: { auth: { mode: "password", password: "stored-password" } },
        },
      ),
    ).toBe("token");
    expect(mode({ gatewayAuth: "password", gatewayToken: "explicit-token" })).toBe("password");
    expect(mode({ gatewayAuth: "token", gatewayPassword: "explicit-password" })).toBe("token");
  });

  it("maps an explicit env-backed token to the canonical SecretRef", () => {
    expect(
      resolveQuickstartGatewayDefaults(storedConfig, {
        gatewayTokenRefEnv: " OPENCLAW_GATEWAY_TOKEN ",
      }),
    ).toMatchObject({
      authMode: "token",
      token: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" },
    });
  });
});

describe("writeWizardConfigFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentConfig = {};
    mocks.transformConfigWithPendingPluginInstalls.mockImplementation(
      async (params: { transform: (current: OpenClawConfig) => { nextConfig: OpenClawConfig } }) =>
        configFiles.write(params.transform(mocks.currentConfig).nextConfig),
    );
  });

  it("delegates CAS and pending-install ownership to the canonical transform", async () => {
    const config: OpenClawConfig = { gateway: { port: 18789 } };
    const baseSnapshot = { path: "/tmp/openclaw.json", exists: false } as ConfigFileSnapshot;
    const afterWrite = { mode: "none" as const, reason: "restart after setup" };

    await writeWizardConfigFile(config, {
      allowConfigSizeDrop: false,
      baseHash: "verified-hash",
      baseSnapshot,
      afterWrite,
    });

    expect(mocks.transformConfigWithPendingPluginInstalls).toHaveBeenCalledWith({
      baseHash: "verified-hash",
      maxAttempts: 1,
      afterWrite,
      writeOptions: { allowConfigSizeDrop: false, baseSnapshot },
      transform: expect.any(Function),
    });
  });

  it("preserves literal nulls added by the wizard", async () => {
    const pluginConfig = (config: Record<string, unknown>): OpenClawConfig => ({
      plugins: { entries: { demo: { enabled: true, config } } },
    });
    const base = pluginConfig({ choice: 1, unchangedNull: null, nested: { existing: true } });
    const next = pluginConfig({
      choice: null,
      unchangedNull: null,
      nested: { existing: true, optional: null },
    });
    const sourceConfig = {
      ...pluginConfig({ choice: 1, unchangedNull: "concurrent", nested: { existing: true } }),
      gateway: { port: 19001 },
    };
    mocks.currentConfig = {
      ...pluginConfig({
        callerOwned: "concurrent",
        choice: 1,
        unchangedNull: "concurrent",
        nested: { existing: true },
      }),
      gateway: { port: 19001 },
    };
    const explicitSetValueSource = pluginConfig({ callerOwned: "caller" });
    mocks.transformConfigWithPendingPluginInstalls.mockImplementationOnce(
      async (params: {
        transform: (current: OpenClawConfig) => { nextConfig: OpenClawConfig };
        writeOptions?: ConfigWriteOptions;
      }) => {
        const nextConfig = params.transform(mocks.currentConfig).nextConfig;
        return {
          nextConfig: resolvePersistCandidateForWrite({
            runtimeConfig: mocks.currentConfig,
            sourceConfig,
            nextConfig,
            ...params.writeOptions,
          }) as OpenClawConfig,
        };
      },
    );

    const committed = await writeWizardConfigFile(next, {
      mergeBase: base,
      writeOptions: {
        explicitSetPaths: [["plugins", "entries", "demo", "config", "callerOwned"]],
        explicitSetValueSource,
      },
    });
    expect(committed.nextConfig).toEqual({
      ...pluginConfig({
        callerOwned: "caller",
        choice: null,
        unchangedNull: "concurrent",
        nested: { existing: true, optional: null },
      }),
      gateway: { port: 19001 },
    });
  });
});
