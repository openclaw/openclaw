import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
// Setup wizard tests cover end-to-end onboarding prompt flows.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import {
  readAuthProfileStoreForTest,
  removeOAuthTestTempRoot,
} from "../agents/auth-profiles/oauth-test-utils.js";
import { upsertAuthProfileWithLock } from "../agents/auth-profiles/profiles.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { committedConfigFiles } from "../commands/committed-config.test-support.js";
import { createConfigIO as createRealConfigIO } from "../config/io.factory.js";
import { coerceConfig } from "../config/io.read-helpers.js";
import { createConfigFileSnapshot } from "../config/io.snapshot-shared.js";
import { migratePersistedImplicitMainRoster } from "../config/legacy.roster.js";
import { materializeRuntimeConfig } from "../config/materialize.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginCompatibilityNotice } from "../plugins/status.js";
import type { RuntimeEnv } from "../runtime.js";
import { WizardCancelledError, type WizardPrompter, type WizardSelectParams } from "./prompts.js";
import { runSetupWizard } from "./setup.js";
import {
  SetupMigrationFreshnessError,
  SetupMigrationTargetChangedError,
} from "./setup.migration-snapshot.js";

type ResolveProviderPluginChoice =
  typeof import("../plugins/provider-auth-choice.runtime.js").resolveProviderPluginChoice;
type ResolveProviderOnboardAuthFlags =
  typeof import("../plugins/provider-auth-choices.js").resolveProviderOnboardAuthFlags;
type PromptDefaultModel = typeof import("../flows/model-picker.js").promptDefaultModel;
type ApplyAuthChoice = typeof import("../commands/auth-choice.apply.js").applyAuthChoice;
type PrepareAuthChoice = typeof import("../commands/auth-choice.apply.js").prepareAuthChoice;
type VerifySetupInferenceConfig =
  typeof import("../system-agent/setup-inference.js").verifySetupInferenceConfig;
type ConfigureGatewayForSetup = typeof import("./setup.gateway-config.js").configureGatewayForSetup;
type ListSetupMigrationOptions =
  typeof import("./setup.migration-import.js").listSetupMigrationOptions;
type RunSetupMigrationImport = typeof import("./setup.migration-import.js").runSetupMigrationImport;
type RunSearchSetupFlow = typeof import("../flows/search-setup.js").runSearchSetupFlow;

const ensureAuthProfileStore = vi.hoisted(() => vi.fn(() => ({ profiles: {} })));
const promptAuthChoiceGrouped = vi.hoisted(() => vi.fn(async () => "skip"));
const applyAuthChoice = vi.hoisted(() =>
  vi.fn<ApplyAuthChoice>(async (args) => ({ config: args.config })),
);
const prepareAuthChoice = vi.hoisted(() => vi.fn<PrepareAuthChoice>());
const resolveProviderOnboardAuthFlags = vi.hoisted(() =>
  vi.fn<ResolveProviderOnboardAuthFlags>(() => []),
);
const resolveProviderPluginChoice = vi.hoisted(() =>
  vi.fn<ResolveProviderPluginChoice>(() => null),
);
const resolvePluginProviders = vi.hoisted(() =>
  vi.fn<typeof import("../plugins/provider-auth-choice.runtime.js").resolvePluginProviders>(
    () => [],
  ),
);
const warnIfModelConfigLooksOff = vi.hoisted(() => vi.fn(async () => {}));

const promptDefaultModel = vi.hoisted(() => vi.fn<PromptDefaultModel>(async () => ({})));

const configureGatewayForSetup = vi.hoisted(() => vi.fn<ConfigureGatewayForSetup>());
const finalizeSetupWizard = vi.hoisted(() =>
  vi.fn<typeof import("./setup.finalize.js").finalizeSetupWizard>(async () => ({
    launchedTui: false,
  })),
);
const listChannelPlugins = vi.hoisted(() => vi.fn(() => []));
const logConfigUpdated = vi.hoisted(() => vi.fn(() => {}));

const detectSetupMigrationSources = vi.hoisted(() =>
  vi.fn(async () => ({ detections: [], providerDescriptors: [] })),
);
const listSetupMigrationOptions = vi.hoisted(() =>
  vi.fn<ListSetupMigrationOptions>(async () => []),
);
const runSetupMigrationImport = vi.hoisted(() =>
  vi.fn<RunSetupMigrationImport>(async () => ({ kind: "no-imported-inference" })),
);
const runSetupMemoryImportStep = vi.hoisted(() => vi.fn(async () => {}));
const verifySetupInferenceConfig = vi.hoisted(() => vi.fn<VerifySetupInferenceConfig>());

const setupChannels = vi.hoisted(() =>
  vi.fn<typeof import("../flows/channel-setup.js").setupChannels>(async (cfg) => cfg),
);

const runSearchSetupFlow = vi.hoisted(() =>
  vi.fn<RunSearchSetupFlow>(async (config) => ({ outcome: "completed", config })),
);
const promptRemoteGatewayConfig = vi.hoisted(() =>
  vi.fn<typeof import("../commands/onboard-remote.js").promptRemoteGatewayConfig>(
    async (cfg) => cfg,
  ),
);
const validateGatewayWebSocketUrl = vi.hoisted(() =>
  vi.fn<(value: string) => string | undefined>(() => undefined),
);

const ensureWorkspaceAndSessions = vi.hoisted(() => vi.fn(async () => {}));
const ensureOnboardingConfig = vi.hoisted(() =>
  vi.fn(async ({ config, baseConfig }: { config: OpenClawConfig; baseConfig: OpenClawConfig }) => ({
    config,
    configBase: baseConfig,
    agentId: "main",
    bootstrapPending: true,
  })),
);
const replaceConfigFile = vi.hoisted(() =>
  vi.fn(async (params: { nextConfig: OpenClawConfig }) => ({ nextConfig: params.nextConfig })),
);
const resolveGatewayPort = vi.hoisted(() =>
  vi.fn((_cfg?: unknown, env?: NodeJS.ProcessEnv) => {
    const raw = env?.OPENCLAW_GATEWAY_PORT ?? process.env.OPENCLAW_GATEWAY_PORT;
    const port = raw ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(port) && port > 0 ? port : 18789;
  }),
);
const readConfigFileSnapshot = vi.hoisted(() =>
  vi.fn<typeof import("../config/io.js").readConfigFileSnapshot>(),
);
const createConfigIO = vi.hoisted(() => vi.fn(() => ({ readConfigFileSnapshot })));
const probeGatewayReachable = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const buildPluginCompatibilitySnapshotNotices = vi.hoisted(() =>
  vi.fn((): PluginCompatibilityNotice[] => []),
);
const formatPluginCompatibilityNotice = vi.hoisted(() =>
  vi.fn((notice: PluginCompatibilityNotice) => `${notice.pluginId} ${notice.message}`),
);

function providerFlag(
  optionKey: ReturnType<ResolveProviderOnboardAuthFlags>[number]["optionKey"],
  authChoice: ReturnType<ResolveProviderOnboardAuthFlags>[number]["authChoice"],
  cliFlag: string,
) {
  return {
    optionKey,
    authChoice,
    cliFlag,
    cliOption: `${cliFlag} <key>`,
    description: "Provider credential",
  };
}

function storedRemote(
  extra: Partial<NonNullable<NonNullable<OpenClawConfig["gateway"]>["remote"]>> = {},
) {
  return {
    url: "wss://stored.example.com:18789",
    token: { source: "env", provider: "default", id: "STORED_GATEWAY_TOKEN" },
    password: { source: "env", provider: "default", id: "STORED_GATEWAY_PASSWORD" },
    ...extra,
  } satisfies NonNullable<NonNullable<OpenClawConfig["gateway"]>["remote"]>;
}

function remotePromptCalls() {
  return promptRemoteGatewayConfig.mock.calls.map(([config, prompter, options]) => ({
    remote: config.gateway?.remote,
    prompter,
    options,
  }));
}

function modelConfig(primary: string): OpenClawConfig {
  return { agents: { defaults: { model: { primary } }, entries: { main: { default: true } } } };
}

function modelConfigWithApiKey(apiKey: string, agentDir: string): OpenClawConfig {
  return {
    agents: {
      defaults: { model: { primary: "openai/gpt-5.5" } },
      entries: { main: { default: true, agentDir } },
    },
    auth: {
      profiles: { "openai:default": { provider: "openai", mode: "api_key" } },
      order: { openai: ["openai:default"] },
    },
    models: {
      providers: {
        openai: {
          apiKey,
          baseUrl: "https://api.openai.com/v1",
          models: [],
        },
      },
    },
  };
}

function openAiAuthProfile(apiKey: string) {
  return {
    profileId: "openai:default",
    credential: { type: "api_key" as const, provider: "openai", key: apiKey },
  };
}

function expectSavedSetupCredential(config: OpenClawConfig, agentDir: string, key: string): string {
  const primary = expectDefined(
    resolveAgentModelPrimaryValue(config.agents?.defaults?.model),
    "selected model",
  );
  const profileId = expectDefined(
    splitTrailingAuthProfile(primary).profile,
    "selected credential profile",
  );
  expect(profileId).toMatch(/^openai:setup-/);
  const { setup, ...credential } = expectDefined(
    readAuthProfileStoreForTest(agentDir).profiles[profileId],
    "saved credential profile",
  );
  expect(credential).toEqual(openAiAuthProfile(key).credential);
  if (setup) {
    expect(setup).toMatchObject({
      modelRef: "openai/gpt-5.5",
      replacement: expect.any(Boolean),
      configJson: expect.any(String),
    });
  }
  return profileId;
}

function prepareMockAuthProfilesIn(agentDir: string): void {
  prepareAuthChoice.mockImplementation(async (args) => {
    const result = await applyAuthChoice(args);
    const apiKey = result.config.models?.providers?.openai?.apiKey;
    if (typeof apiKey !== "string") {
      return {
        ...result,
        authProfiles: [],
        persistAuthProfiles: async () => {},
      };
    }
    const profile = openAiAuthProfile(apiKey);
    return {
      ...result,
      authProfiles: [profile],
      persistAuthProfiles: async (profiles) => {
        await persistAuthProfileBatch({ profiles: profiles ?? [profile], agentDir });
      },
    };
  });
}

function queueCredentialVerification(
  agentDir: string,
  key: string,
  result: Awaited<ReturnType<VerifySetupInferenceConfig>> = {
    ok: false,
    status: "auth",
    error: "fixture credential rejected",
  },
) {
  verifySetupInferenceConfig.mockImplementationOnce(async ({ config }) => {
    expectSavedSetupCredential(config, agentDir, key);
    expect(replaceConfigFile).not.toHaveBeenCalled();
    return result;
  });
}

function verifiedConfig(index: number): OpenClawConfig {
  return expectDefined(verifySetupInferenceConfig.mock.calls[index]?.[0], "verification call")
    .config;
}

function persistedWizardConfigs(): OpenClawConfig[] {
  return replaceConfigFile.mock.calls.map(([params]) => params.nextConfig);
}

vi.mock("../flows/channel-setup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../flows/channel-setup.js")>()),
  setupChannels,
}));

vi.mock("../flows/search-setup.js", () => ({ runSearchSetupFlow }));

vi.mock("../commands/onboard-remote.js", () => ({
  promptRemoteGatewayConfig,
  validateGatewayWebSocketUrl,
}));

vi.mock("../agents/auth-profiles.js", async () => {
  const persistence = await import("../agents/auth-profiles/upsert-with-lock.js");
  return { ensureAuthProfileStore, persistAuthProfileBatch: persistence.persistAuthProfileBatch };
});

vi.mock("../agents/auth-profiles.runtime.js", () => ({ ensureAuthProfileStore }));

vi.mock("../commands/auth-choice-prompt.js", () => ({
  isKeepCurrentAuthChoice: (value: unknown) => value === "__keep-current",
  promptAuthChoiceGrouped,
}));

vi.mock("../commands/auth-choice.apply.js", () => ({ applyAuthChoice, prepareAuthChoice }));

vi.mock("../plugins/provider-auth-choice-preference.js", () => ({
  resolvePreferredProviderForAuthChoice: async () => "demo-provider",
}));

vi.mock("../commands/auth-choice.model-check.js", () => ({ warnIfModelConfigLooksOff }));

vi.mock("../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoice: () => undefined,
  resolveManifestProviderAuthChoices: () => [],
  resolveProviderOnboardAuthFlags,
}));

vi.mock("../plugins/setup-registry.js", () => ({
  resolvePluginSetupProviderCore: () => undefined,
  resolvePluginSetupCliBackend: () => undefined,
  resolvePluginSetupRegistry: () => ({
    providers: [],
    cliBackends: [],
    configMigrations: [],
    autoEnableProbes: [],
    diagnostics: [],
  }),
}));

vi.mock("../plugins/provider-auth-choice.runtime.js", () => ({
  resolveProviderPluginChoice,
  resolvePluginProviders,
}));

vi.mock("../flows/model-picker.js", () => ({ promptDefaultModel }));

vi.mock("./setup.migration-import.js", () => ({
  detectSetupMigrationSources,
  listSetupMigrationOptions,
  runSetupMigrationImport,
}));

vi.mock("./setup.memory-import.js", () => ({ runSetupMemoryImportStep }));

vi.mock("../system-agent/setup-inference.js", () => ({ verifySetupInferenceConfig }));

vi.mock("../config/config.js", async (importActual) => {
  const actual = await importActual<typeof import("../config/config.js")>();
  return {
    DEFAULT_GATEWAY_PORT: 18789,
    createConfigIO,
    readConfigFileSnapshot,
    resolveConfigWriteAfterWrite: actual.resolveConfigWriteAfterWrite,
    resolveGatewayPort,
    replaceConfigFile,
    transformConfigFileWithRetry: async (
      params: Parameters<typeof actual.transformConfigFileWithRetry>[0],
    ) => {
      const snapshot = await readConfigFileSnapshot();
      const previousHash = snapshot.hash ?? null;
      const config = params.base === "runtime" ? snapshot.runtimeConfig : snapshot.sourceConfig;
      const transformed = await params.transform(
        config,
        { snapshot, previousHash, attempt: 0 },
        {},
      );
      const committed = await expectDefined(
        params.commit,
        "fixture commit",
      )({
        nextConfig: transformed.nextConfig,
        snapshot,
        ...(previousHash ? { baseHash: previousHash } : {}),
        writeOptions: params.writeOptions,
        afterWrite: { mode: "auto" },
      });
      return committedConfigFiles.write(committed.config, snapshot.path);
    },
  };
});
vi.mock("../commands/onboard-agent.js", async () => {
  return {
    ensureOnboardingAgent: ensureOnboardingConfig,
    validateFirstOnboardingAgentName: (value: string | undefined) =>
      value?.trim() ? undefined : "Agent name is required.",
  };
});
vi.mock("../commands/onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "/tmp/openclaw-workspace",
  applyWizardMetadata: (cfg: unknown) => cfg,
  summarizeExistingConfig: () => "summary",
  ensureWorkspaceAndSessions,
  printWizardHeader: vi.fn(),
  probeGatewayReachable,
}));

vi.mock("../plugins/status.js", () => ({
  buildPluginCompatibilitySnapshotNotices,
  formatPluginCompatibilityNotice,
}));

vi.mock("../channels/plugins/index.js", () => ({ listChannelPlugins }));

vi.mock("../config/logging.js", () => ({ logConfigUpdated }));

vi.mock("./setup.gateway-config.js", () => ({ configureGatewayForSetup }));

vi.mock("./setup.finalize.js", () => ({ finalizeSetupWizard }));

function createRuntime(opts?: { throwsOnExit?: boolean }): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      if (opts?.throwsOnExit) {
        throw new Error(`exit:${code}`);
      }
    }),
  };
}

function buildWizardPrompter(
  overrides?: Partial<WizardPrompter>,
  options?: Parameters<typeof createWizardPrompter>[1],
): WizardPrompter {
  return createWizardPrompter(
    {
      text: vi.fn(async ({ initialValue }) => initialValue ?? ""),
      ...overrides,
    },
    options,
  );
}

const defaultSetupOptions = {
  acceptRisk: true,
  flow: "quickstart",
  authChoice: "skip",
  installDaemon: false,
  skipChannels: true,
  skipSkills: true,
  skipSearch: true,
  skipHealth: true,
  skipUi: true,
} satisfies Parameters<typeof runSetupWizard>[0];

async function runWizard(
  options: Parameters<typeof runSetupWizard>[0] = {},
  runtime = createRuntime(),
  prompter = buildWizardPrompter(),
) {
  await runSetupWizard({ ...defaultSetupOptions, ...options }, runtime, prompter);
}

describe("runSetupWizard", () => {
  afterEach(() => vi.unstubAllEnvs());
  let suiteRoot = "";
  let suiteCase = 0;

  beforeAll(async () => {
    suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-onboard-suite-"));
  });

  afterAll(async () => {
    await fs.rm(suiteRoot, { recursive: true, force: true });
    suiteRoot = "";
    suiteCase = 0;
  });

  async function makeCaseDir(prefix: string): Promise<string> {
    const dir = path.join(suiteRoot, `${prefix}${++suiteCase}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  function configSnapshot(config: OpenClawConfig, exists = true): ConfigFileSnapshot {
    const sourceConfig = coerceConfig(migratePersistedImplicitMainRoster(config).config);
    return createConfigFileSnapshot({
      path: "/tmp/.openclaw/openclaw.json",
      exists,
      raw: exists ? JSON.stringify(config) : null,
      parsed: exists ? config : {},
      sourceConfigBeforeMigrations: exists ? config : undefined,
      sourceConfig,
      valid: true,
      runtimeConfig: materializeRuntimeConfig(sourceConfig, { manifestRegistry: { plugins: [] } }),
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
  }

  function readExistingModel() {
    const existingConfig = modelConfig("anthropic/sonnet-4.6");
    readConfigFileSnapshot.mockImplementation(async () =>
      configSnapshot(persistedWizardConfigs().at(-1) ?? existingConfig),
    );
  }

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", undefined);
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", undefined);
    vi.clearAllMocks();
    committedConfigFiles.clear();
    promptAuthChoiceGrouped.mockReset().mockResolvedValue("skip");
    applyAuthChoice.mockReset().mockImplementation(async (args) => ({ config: args.config }));
    prepareAuthChoice.mockReset().mockImplementation(async (args) => ({
      ...(await applyAuthChoice(args)),
      authProfiles: [],
      persistAuthProfiles: async () => {},
    }));
    setupChannels.mockReset().mockImplementation(async (cfg) => cfg);
    runSearchSetupFlow.mockReset().mockImplementation(async (config: OpenClawConfig) => ({
      outcome: "completed",
      config,
    }));
    promptRemoteGatewayConfig.mockReset().mockImplementation(async (cfg) => cfg);
    validateGatewayWebSocketUrl.mockReset().mockReturnValue(undefined);
    configureGatewayForSetup.mockReset().mockImplementation(async (args) => ({
      nextConfig: args.nextConfig,
      settings: {
        port: args.localPort ?? 18789,
        bind: "loopback",
        authMode: "token",
        gatewayToken: "test-token",
        tailscaleMode: "off",
      },
    }));
    let authoredConfig: OpenClawConfig | undefined;
    readConfigFileSnapshot
      .mockReset()
      .mockImplementation(async () =>
        configSnapshot(authoredConfig ?? {}, authoredConfig !== undefined),
      );
    replaceConfigFile.mockReset().mockImplementation(async (params) => {
      authoredConfig = structuredClone(params.nextConfig);
      return { nextConfig: params.nextConfig };
    });
    probeGatewayReachable.mockReset().mockResolvedValue({ ok: false });
    resolveProviderOnboardAuthFlags.mockReset().mockReturnValue([]);
    resolveProviderPluginChoice.mockReset().mockReturnValue(null);
    resolvePluginProviders.mockReset().mockReturnValue([]);
    promptDefaultModel.mockReset().mockResolvedValue({});
    warnIfModelConfigLooksOff.mockReset().mockResolvedValue(undefined);
    buildPluginCompatibilitySnapshotNotices.mockReset().mockReturnValue([]);
    runSetupMigrationImport.mockReset().mockResolvedValue({ kind: "no-imported-inference" });
    verifySetupInferenceConfig.mockReset().mockResolvedValue({
      ok: true,
      modelRef: "openai/gpt-5.5",
      latencyMs: 250,
    });
    runSetupMemoryImportStep.mockReset().mockResolvedValue(undefined);
    ensureOnboardingConfig.mockClear();
  });

  it("exits successfully after the auto-launched TUI returns", async () => {
    finalizeSetupWizard.mockResolvedValueOnce({ launchedTui: true });
    await expect(runWizard({}, createRuntime({ throwsOnExit: true }))).rejects.toThrow("exit:0");
  });

  const configuredRemoteProbeArgs = {
    originScopedDeviceAuth: true,
    configuredRemote: true,
    url: "wss://gateway.example.test",
    config: expect.any(Object),
    token: undefined,
  };

  it.each([
    { name: "token", optionKey: "remoteToken", remoteKey: "token" },
    { name: "password", optionKey: "remotePassword", remoteKey: "password" },
  ])("seeds interactive remote $name auth from command flags", async ({ optionKey, remoteKey }) => {
    const remoteCredential = "REDACTED";
    readConfigFileSnapshot.mockResolvedValueOnce(
      configSnapshot({ gateway: { remote: storedRemote() } }),
    );
    const prompter = buildWizardPrompter();
    const runtime = createRuntime();

    if (remoteKey === "password") {
      vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "ambient-gateway-token");
    }
    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "advanced",
        mode: "remote",
        remoteUrl: " wss://flag.example.com:18789 ",
        [optionKey]: ` ${remoteCredential} `,
      },
      runtime,
      prompter,
    );

    expect(probeGatewayReachable).toHaveBeenCalledWith({
      ...configuredRemoteProbeArgs,
      configuredRemote: false,
      url: "wss://flag.example.com:18789",
      token: remoteKey === "token" ? remoteCredential : undefined,
      ...(remoteKey === "password" ? { password: remoteCredential } : {}),
    });
    expect(remotePromptCalls()).toContainEqual({
      remote: {
        url: "wss://flag.example.com:18789",
        token: remoteKey === "token" ? remoteCredential : undefined,
        password: remoteKey === "password" ? remoteCredential : undefined,
      },
      prompter: expect.any(Object),
      options: { secretInputMode: undefined, remoteOriginUrl: "wss://stored.example.com:18789" },
    });
    expect(promptRemoteGatewayConfig.mock.calls[0]?.[2]).toStrictEqual({
      secretInputMode: undefined,
      remoteOriginUrl: "wss://stored.example.com:18789",
    });
    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining(remoteCredential));
  });

  it("does not reuse stored remote credentials for an overridden URL", async () => {
    const remote = storedRemote({
      edgeAuth: { "X-Edge-Auth": "test-secret" },
      tlsFingerprint: "ab".repeat(32),
    });
    readConfigFileSnapshot.mockResolvedValueOnce(configSnapshot({ gateway: { remote } }));
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "ambient-password"); // pragma: allowlist secret

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "advanced",
        mode: "remote",
        remoteUrl: "wss://flag.example.com:18789",
      },
      createRuntime(),
      buildWizardPrompter(),
    );

    expect(probeGatewayReachable).toHaveBeenCalledWith({
      ...configuredRemoteProbeArgs,
      configuredRemote: false,
      url: "wss://flag.example.com:18789",
      config: expect.objectContaining({
        gateway: expect.objectContaining({
          remote: expect.objectContaining({
            url: "wss://stored.example.com:18789",
            edgeAuth: { "X-Edge-Auth": "test-secret" },
            tlsFingerprint: "ab".repeat(32),
          }),
        }),
      }),
    });
    expect(remotePromptCalls()).toContainEqual({
      remote: {
        ...remote,
        url: "wss://flag.example.com:18789",
        token: undefined,
        password: undefined,
      },
      prompter: expect.any(Object),
      options: { secretInputMode: undefined, remoteOriginUrl: remote.url },
    });
  });

  it("does not probe an invalid CLI remote URL with its token", async () => {
    const remoteToken = "REDACTED";
    validateGatewayWebSocketUrl.mockReturnValueOnce("Use wss:// for public gateways");

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "advanced",
        mode: "remote",
        remoteUrl: "ws://public.example",
        remoteToken,
      },
      createRuntime(),
      buildWizardPrompter(),
    );

    expect(validateGatewayWebSocketUrl).toHaveBeenCalledWith("ws://public.example");
    expect(probeGatewayReachable).not.toHaveBeenCalledWith(
      expect.objectContaining({ url: "ws://public.example" }),
    );
  });

  it("leaves feature-stat telemetry unset during non-interactive wizard setup", async () => {
    const prompter = buildWizardPrompter();

    await runWizard({ nonInteractive: true }, createRuntime({ throwsOnExit: true }), prompter);

    expect(persistedWizardConfigs().at(-1)?.telemetry).toBeUndefined();
    expect(prompter.select).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Help make OpenClaw better?" }),
    );
  });

  it.each([
    {
      label: "freshness rejection",
      error: new SetupMigrationFreshnessError(
        "Migration import during onboarding requires a fresh OpenClaw setup.\nExisting setup:\n- state agents/ exists",
      ),
      detail: "state agents/ exists",
    },
    {
      label: "target change",
      error: new SetupMigrationTargetChangedError(
        "Migration target changed before promotion. Review it and retry.",
      ),
      detail: "Migration target changed before promotion",
    },
  ])("returns to setup mode after an interactive import $label", async ({ error, detail }) => {
    listSetupMigrationOptions.mockResolvedValueOnce([
      { providerId: "hermes", label: "Import from Hermes" },
    ]);
    runSetupMigrationImport.mockRejectedValueOnce(error);
    const setupChoices: Array<"import" | "quickstart"> = ["import", "quickstart"];
    const select = vi.fn(async (params: WizardSelectParams<unknown>) => {
      if (params.message === "Setup mode") {
        expect(params.options).toEqual([
          expect.objectContaining({ value: "quickstart", label: "QuickStart (recommended)" }),
          expect.objectContaining({ value: "advanced", label: "Manual setup" }),
          expect.objectContaining({ value: "import", label: "Import from another agent" }),
        ]);
        return setupChoices.shift();
      }
      return "__skip__";
    });
    const prompter = buildWizardPrompter({ select: select as unknown as WizardPrompter["select"] });

    await runWizard({ flow: undefined }, createRuntime(), prompter);

    expect(select.mock.calls.filter(([params]) => params.message === "Setup mode")).toHaveLength(2);
    expect(runSetupMigrationImport).toHaveBeenCalledOnce();
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining(detail),
      "Existing config detected",
    );
    expect(finalizeSetupWizard).toHaveBeenCalledOnce();
  });

  it("returns from the migration picker without restarting setup", async () => {
    listSetupMigrationOptions.mockResolvedValueOnce([
      { providerId: "hermes", label: "Import from Hermes" },
    ]);
    runSetupMigrationImport.mockResolvedValueOnce({ kind: "back" });
    const setupChoices: Array<"import" | "quickstart"> = ["import", "quickstart"];
    const select = vi.fn(async ({ message }: WizardSelectParams<unknown>) =>
      message === "Setup mode" ? setupChoices.shift() : "__skip__",
    );

    await runWizard(
      { flow: undefined },
      createRuntime(),
      buildWizardPrompter({ select: select as unknown as WizardPrompter["select"] }),
    );

    expect(select.mock.calls.filter(([params]) => params.message === "Setup mode")).toHaveLength(2);
    expect(detectSetupMigrationSources).toHaveBeenCalledOnce();
    expect(runSetupMigrationImport).toHaveBeenCalledOnce();
    expect(finalizeSetupWizard).toHaveBeenCalledOnce();
  });

  it("continues onboarding after a recovered promotion", async () => {
    const acknowledgePromotion = vi.fn(async () => {});
    runSetupMigrationImport.mockResolvedValueOnce({
      kind: "no-imported-inference",
      acknowledgePromotion,
    });

    await runWizard({ importFrom: "hermes" });

    expect(finalizeSetupWizard).toHaveBeenCalledOnce();
    expect(acknowledgePromotion).toHaveBeenCalledOnce();
    expect(runSetupMemoryImportStep).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "absent roster",
      agents: {},
      authored: false,
      include: false,
      requestedName: undefined,
    },
    {
      label: "authored bare main",
      agents: { entries: { main: {} } },
      authored: true,
      include: false,
      requestedName: "robby",
    },
    {
      label: "include-owned bare main",
      agents: { entries: { main: {} } },
      authored: true,
      include: true,
      requestedName: undefined,
    },
  ])(
    "uses authored membership for same-command import and naming: $label, name=$requestedName",
    async ({ agents, authored, include, requestedName }) => {
      const workspaceDir = await fs.realpath(await makeCaseDir("import-naming-"));
      const configPath = path.join(workspaceDir, "openclaw.json");
      if (include) {
        await fs.writeFile(path.join(workspaceDir, "roster.json"), JSON.stringify({ agents }));
      }
      await fs.writeFile(
        configPath,
        JSON.stringify({
          ...(include ? { $include: "./roster.json" } : {}),
          agents: { ...(!include ? agents : {}), defaults: { workspace: workspaceDir } },
        }),
      );
      const importedSnapshot = await createRealConfigIO({
        configPath,
        pluginValidation: "skip",
      }).readConfigFileSnapshot();
      expect(importedSnapshot.valid).toBe(true);
      readConfigFileSnapshot
        .mockResolvedValueOnce(configSnapshot({}, false))
        .mockResolvedValue(importedSnapshot);
      const runtime = createRuntime();
      const prompter = buildWizardPrompter({ text: vi.fn(async () => "robby") });

      await runWizard(
        { importFrom: "hermes", agentName: requestedName, workspace: workspaceDir },
        runtime,
        prompter,
      );

      expect(runSetupMigrationImport).toHaveBeenCalledOnce();
      if (authored && requestedName) {
        expect(runtime.error).toHaveBeenCalledWith(
          "--agent-name cannot be combined with an import that supplies an agent roster. Remove --agent-name or choose an import without agents.",
        );
        expect(runtime.exit).toHaveBeenCalledWith(1);
        expect(ensureOnboardingConfig).not.toHaveBeenCalled();
      } else {
        expect(runtime.error).not.toHaveBeenCalled();
        expect(ensureOnboardingConfig).toHaveBeenCalledWith(
          expect.objectContaining({
            ...(authored ? {} : { firstAgent: { name: "robby" } }),
            workspace: workspaceDir,
            preserveCandidateRoster: authored,
          }),
        );
        expect(finalizeSetupWizard).toHaveBeenCalledOnce();
      }
      const namePrompt = expect.objectContaining({
        message: "What should we call your first agent?",
      });
      if (!authored && !requestedName) {
        expect(prompter.text).toHaveBeenCalledWith(namePrompt);
      } else {
        expect(prompter.text).not.toHaveBeenCalledWith(namePrompt);
      }
    },
  );

  it.each([false, true])(
    "reuses imported verification only for an unchanged model (changed: %s)",
    async (changed) => {
      runSetupMigrationImport.mockResolvedValueOnce({
        kind: "verified-inference",
        modelRef: "openai/gpt-5.6-sol",
      });
      const imported = modelConfig(changed ? "anthropic/claude-sonnet-4-6" : "openai/gpt-5.6-sol");
      readConfigFileSnapshot
        .mockResolvedValueOnce(configSnapshot({}, false))
        .mockResolvedValue(configSnapshot(imported));
      const confirm = vi.fn(async () => !changed);
      await runWizard(
        { importFrom: "hermes", authChoice: changed ? "demo-provider" : "skip" },
        createRuntime(),
        buildWizardPrompter({ confirm }),
      );
      expect(applyAuthChoice).toHaveBeenCalledTimes(changed ? 1 : 0);
      expect(verifySetupInferenceConfig).not.toHaveBeenCalled();
      if (!changed) {
        expect(confirm).not.toHaveBeenCalledWith(
          expect.objectContaining({ message: "Test AI access now with a live completion?" }),
        );
      }
    },
  );

  it("treats --import-source alone as import intent instead of prompting for a setup mode", async () => {
    const prompter = buildWizardPrompter();
    const runtime = createRuntime();

    await runWizard({ importSource: "~/.hermes", flow: undefined }, runtime, prompter);

    expect(runSetupMigrationImport).toHaveBeenCalledOnce();
    expect(runSetupMigrationImport).toHaveBeenCalledWith(
      expect.objectContaining({ opts: expect.objectContaining({ importSource: "~/.hermes" }) }),
    );
    expect(prompter.select).toHaveBeenCalledOnce();
    expect(prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Help make OpenClaw better?", initialValue: false }),
    );
  });

  it("fails fast if the auth choice prompt returns nothing", async () => {
    promptAuthChoiceGrouped.mockImplementationOnce(async () => undefined as never);

    await expect(runWizard({ authChoice: undefined })).rejects.toThrow("auth choice is required");
  });

  it.each([false, true])(
    "moves a fleet workspace only with confirmation (accepted: %s)",
    async (accepted) => {
      const currentWorkspace = await makeCaseDir("fleet-current-");
      const requestedWorkspace = await makeCaseDir("fleet-requested-");
      const config: OpenClawConfig = accepted
        ? {
            wizard: { securityAcknowledgedAt: "2026-06-30T00:00:00.000Z" },
            agents: {
              defaults: { workspace: currentWorkspace },
              list: [{ id: "main", default: true }, { id: "ops" }],
            },
          }
        : {
            agents: {
              ownership: "explicit",
              defaults: { workspace: currentWorkspace, systemAgent: { agentId: "main" } },
              entries: { main: {}, ops: {} },
            },
          };
      if (accepted) {
        readConfigFileSnapshot.mockResolvedValueOnce(configSnapshot(config));
      } else {
        readConfigFileSnapshot
          .mockResolvedValueOnce(configSnapshot({}, false))
          .mockResolvedValue(configSnapshot(config));
      }
      const confirm = vi.fn(async () => accepted);
      const prompter = buildWizardPrompter({ confirm });
      await runWizard(
        { workspace: requestedWorkspace, ...(!accepted ? { importFrom: "hermes" } : {}) },
        createRuntime(),
        prompter,
      );
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("Move the existing agent fleet"),
          initialValue: false,
        }),
      );
      const final = persistedWizardConfigs().at(-1)?.agents;
      expect(final?.defaults?.workspace).toBe(accepted ? requestedWorkspace : currentWorkspace);
      if (accepted) {
        expect(vi.mocked(prompter.note).mock.calls.flat().join("\n")).toContain(currentWorkspace);
        expect(ensureWorkspaceAndSessions).toHaveBeenCalledWith(
          requestedWorkspace,
          expect.anything(),
          expect.any(Object),
        );
      } else {
        expect(final?.entries).toEqual(config.agents?.entries);
        expect(final?.defaults?.systemAgent).toEqual({ agentId: "main" });
      }
    },
  );

  it("continues onboarding when search-provider installation fails", async () => {
    const config: OpenClawConfig = { agents: { defaults: { workspace: "/tmp/workspace" } } };
    runSearchSetupFlow.mockResolvedValueOnce({
      outcome: "install-failed",
      config,
      providerId: "brave",
      reason: "failed",
    });
    readConfigFileSnapshot.mockResolvedValueOnce(configSnapshot(config));

    await expect(runWizard({ skipSearch: undefined })).resolves.toBeUndefined();

    expect(runSearchSetupFlow).toHaveBeenCalledOnce();
    expect(finalizeSetupWizard).toHaveBeenCalledOnce();
  });

  it("persists classic channel setup before hooks and Gateway finalization", async () => {
    const beforeConfig = { agents: { defaults: { workspace: "/tmp/workspace" } } };
    const configured = {
      ...beforeConfig,
      channels: { matrix: { accounts: { ops: { enabled: true } } } },
    } satisfies OpenClawConfig;
    const hook = vi.fn();
    const isConfiguredWrite = (value: OpenClawConfig) =>
      value.channels?.matrix?.accounts?.ops?.enabled === true;
    setupChannels.mockImplementationOnce(async (_cfg, _runtime, _prompter, options) => {
      options?.onPostWriteHook?.({ channel: "matrix", accountId: "ops", run: hook });
      return configured;
    });
    readConfigFileSnapshot.mockResolvedValueOnce(configSnapshot(beforeConfig));

    await runWizard({ skipChannels: undefined });

    const configuredWriteIndex = replaceConfigFile.mock.calls.findIndex(([params]) =>
      isConfiguredWrite(params.nextConfig),
    );
    expect(configuredWriteIndex).toBeGreaterThanOrEqual(0);
    expect(replaceConfigFile.mock.invocationCallOrder[configuredWriteIndex]).toBeLessThan(
      hook.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(hook).toHaveBeenCalledWith({ cfg: configured, runtime: expect.any(Object) });
    expect(hook.mock.invocationCallOrder[0]).toBeLessThan(
      finalizeSetupWizard.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("honors a provider-required picker while keeping existing model settings", async () => {
    const modelSelection = { promptWhenAuthChoiceProvided: true, allowKeepCurrent: false };
    promptDefaultModel.mockResolvedValueOnce({ model: "ollama/llama3" });
    resolveProviderPluginChoice.mockReturnValue({
      provider: { id: "ollama", label: "ollama", auth: [], wizard: { setup: { modelSelection } } },
      method: {
        id: "local",
        label: "ollama",
        kind: "custom",
        run: vi.fn(async () => ({ profiles: [] })),
      },
      wizard: { modelSelection },
    });
    readExistingModel();
    await runWizard(
      { authChoice: "ollama", flow: undefined },
      createRuntime(),
      buildWizardPrompter({}, { defaultSelect: "keep-model" }),
    );
    expect(promptDefaultModel).toHaveBeenCalledWith(expect.objectContaining({ allowKeep: false }));
    expect(prepareAuthChoice).toHaveBeenCalledOnce();
    expect(persistedWizardConfigs().at(-1)?.agents?.defaults?.model).toEqual({
      primary: "ollama/llama3",
    });
  });

  it("infers an API-key flag while preserving an existing default model", async () => {
    resolvePluginProviders.mockReturnValueOnce([
      { id: "", label: "Empty", auth: [] },
      { id: "demo-provider", label: "Demo", auth: [], wizard: { setup: {} } },
    ]);
    resolveProviderOnboardAuthFlags.mockReturnValue([
      providerFlag("nvidiaApiKey", "nvidia-api-key", "--nvidia-api-key"),
    ]);
    readExistingModel();
    await runWizard(
      { nvidiaApiKey: "provider-credential-fixture", flow: undefined, authChoice: undefined },
      createRuntime(),
      buildWizardPrompter({}, { defaultSelect: "keep-model" }),
    );
    expect(prepareAuthChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        authChoice: "nvidia-api-key",
        opts: expect.objectContaining({ nvidiaApiKey: "provider-credential-fixture" }),
      }),
    );
    expect(persistedWizardConfigs().at(-1)?.agents?.defaults?.model).toEqual({
      primary: "anthropic/sonnet-4.6",
    });
    expect(promptDefaultModel).not.toHaveBeenCalled();
  });

  it("rejects ambiguous provider credential flags before writing local setup state", async () => {
    resolveProviderOnboardAuthFlags.mockReturnValue([
      providerFlag("nvidiaApiKey", "nvidia-api-key", "--nvidia-api-key"),
      providerFlag("githubCopilotToken", "github-copilot", "--github-copilot-token"),
    ]);
    const runtime = createRuntime();

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        nvidiaApiKey: "nvidia-credential-fixture",
        githubCopilotToken: "copilot-credential-fixture",
      },
      runtime,
      buildWizardPrompter(),
    );

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Multiple provider credential flags"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(prepareAuthChoice).not.toHaveBeenCalled();
    expect(ensureOnboardingConfig).not.toHaveBeenCalled();
    expect(replaceConfigFile).not.toHaveBeenCalled();
  });

  it("re-prompts for auth when applyAuthChoice requests retry selection", async () => {
    promptAuthChoiceGrouped.mockReset();
    promptAuthChoiceGrouped
      .mockResolvedValueOnce("demo-provider-one")
      .mockResolvedValueOnce("demo-provider-two");
    applyAuthChoice.mockReset();
    applyAuthChoice
      .mockImplementationOnce(async (args) => ({
        config: {
          ...args.config,
          plugins: {
            ...args.config.plugins,
            entries: { ...args.config.plugins?.entries, "demo-provider-plugin": { enabled: true } },
          },
        },
        retrySelection: true,
      }))
      .mockImplementationOnce(async (args) => ({
        config: {
          ...args.config,
          agents: {
            ...args.config.agents,
            defaults: {
              ...args.config.agents?.defaults,
              model: { primary: "demo-provider-two/model" },
            },
          },
        },
      }));

    await runWizard({ authChoice: undefined });

    expect(promptAuthChoiceGrouped).toHaveBeenCalledTimes(2);
    expect(applyAuthChoice).toHaveBeenCalledTimes(2);
    const retry = applyAuthChoice.mock.calls[1]?.[0];
    expect(retry?.authChoice).toBe("demo-provider-two");
    expect(retry?.config.plugins?.entries).toEqual({ "demo-provider-plugin": { enabled: true } });
    expect(retry?.config.agents?.entries).toEqual({ main: {} });
    expect(retry?.config.agents?.defaults?.workspace).toBe("/tmp/openclaw-workspace");
  });

  it("shows plugin compatibility notices for an existing valid config", async () => {
    buildPluginCompatibilitySnapshotNotices.mockReturnValue([
      {
        pluginId: "legacy-plugin",
        code: "hook-only",
        compatCode: "hook-only-plugin-shape",
        severity: "info",
        message:
          "is hook-only. This remains a supported compatibility path, but it has not migrated to explicit capability registration yet.",
      },
    ]);
    readConfigFileSnapshot.mockResolvedValueOnce(configSnapshot({ gateway: {} }));

    const note: WizardPrompter["note"] = vi.fn(async () => {});
    const select = vi.fn(async () => "quickstart") as unknown as WizardPrompter["select"];
    const prompter = buildWizardPrompter({ note, select });
    const runtime = createRuntime();

    await runWizard({}, runtime, prompter);

    const calls = vi.mocked(note).mock.calls;
    const noteTitles = calls.map((call) => call?.[1]);
    expect(noteTitles).toContain("Plugin compatibility");
    expect(noteTitles).toContain("Existing config detected");
    expect(select).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Config handling" }),
    );
    expect(note).toHaveBeenCalledWith(expect.stringContaining("legacy-plugin"), expect.anything());
  });

  it("resolves gateway.auth.password SecretRef for local setup probe", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "gateway-ref-password");
    readConfigFileSnapshot.mockResolvedValueOnce(
      configSnapshot({
        gateway: {
          auth: {
            mode: "password",
            password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
          },
        },
      }),
    );
    await runWizard({ mode: "local" });
    expect(probeGatewayReachable).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "ws://127.0.0.1:18789",
        password: "gateway-ref-password",
      }),
    );
  });

  it.each([
    {
      flow: "advanced",
      port: 19511,
      token: "manual-gateway-token-placeholder",
      password: "manual-gateway-password-placeholder",
    },
    {
      flow: "quickstart",
      port: 19001,
      token: undefined,
      password: ["classic", "password", "placeholder"].join("-"),
    },
  ] as const)(
    "uses explicit $flow gateway options without exposing the password",
    async ({ flow, port, token, password }) => {
      const prompter = buildWizardPrompter();
      const runtime = createRuntime();
      if (flow === "quickstart") {
        readConfigFileSnapshot.mockResolvedValueOnce(
          configSnapshot({
            agents: { entries: { main: { default: true } } },
            gateway: {
              port: 19111,
              bind: "loopback",
              auth: { mode: "token", token: "stored-token" },
              tailscale: { mode: "off" },
            },
          }),
        );
        configureGatewayForSetup.mockImplementationOnce(
          async ({ nextConfig, quickstartGateway: gateway }) => ({
            nextConfig: {
              ...nextConfig,
              gateway: {
                ...nextConfig.gateway,
                port: gateway.port,
                bind: gateway.bind,
                auth: {
                  ...nextConfig.gateway?.auth,
                  mode: gateway.authMode,
                  password: gateway.password,
                },
                tailscale: { ...nextConfig.gateway?.tailscale, mode: gateway.tailscaleMode },
              },
            },
            settings: {
              port: gateway.port,
              bind: gateway.bind,
              authMode: gateway.authMode,
              gatewayToken: undefined,
              tailscaleMode: gateway.tailscaleMode,
            },
          }),
        );
      }
      await runWizard(
        {
          flow,
          mode: "local",
          gatewayPort: port,
          gatewayBind: "lan",
          gatewayAuth: "password",
          gatewayPassword: password,
          ...(flow === "advanced" ? { gatewayToken: token, tailscale: "off" } : {}),
        },
        runtime,
        prompter,
      );
      const quickstartGateway = { port, bind: "lan", authMode: "password", password };
      expect(configureGatewayForSetup.mock.calls[0]?.[0].quickstartGateway).toMatchObject(
        quickstartGateway,
      );
      if (flow === "advanced") {
        expect(probeGatewayReachable).toHaveBeenCalledWith(
          expect.objectContaining({ url: `ws://127.0.0.1:${port}`, token, password }),
        );
        expect(configureGatewayForSetup.mock.calls[0]?.[0]).toMatchObject({
          localPort: port,
          quickstartGateway: { ...quickstartGateway, token, tailscaleMode: "off" },
        });
      } else {
        expect(persistedWizardConfigs()).toContainEqual(
          expect.objectContaining({
            gateway: expect.objectContaining({
              port,
              bind: "lan",
              auth: expect.objectContaining({ mode: "password", password }),
            }),
          }),
        );
        const visibleOutput = [
          ...vi.mocked(prompter.note).mock.calls.flat(),
          ...vi.mocked(runtime.log).mock.calls.flat(),
          ...vi.mocked(runtime.error).mock.calls.flat(),
        ].join("\n");
        expect(visibleOutput).toContain(String(port));
        expect(visibleOutput).not.toContain("Keeping your current gateway settings:");
        expect(visibleOutput).not.toContain(password);
      }
    },
  );

  it("localizes the quickstart summary", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", "18791");
    vi.stubEnv("OPENCLAW_LOCALE", "zh-CN");
    const prompter = buildWizardPrompter();
    await runWizard({}, createRuntime(), prompter);
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("Gateway 端口：18791"),
      "QuickStart",
    );
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("Tailscale 暴露方式：关闭"),
      "QuickStart",
    );
  });

  it("verifies and persists managed-local setup without enabling lean mode", async () => {
    const modelRef = "managed-local/test-model";
    readConfigFileSnapshot.mockResolvedValue(configSnapshot({}));
    replaceConfigFile.mockImplementation(async ({ nextConfig }) => {
      readConfigFileSnapshot.mockResolvedValue(configSnapshot(nextConfig));
      return { nextConfig };
    });
    applyAuthChoice.mockImplementationOnce(async (args) => ({
      config: {
        ...args.config,
        agents: {
          ...args.config.agents,
          defaults: { ...args.config.agents?.defaults, model: { primary: modelRef } },
        },
        models: {
          providers: {
            "managed-local": {
              baseUrl: "http://127.0.0.1:8080/v1",
              models: [],
              localService: { command: "/fixture/server" },
            },
          },
        },
      },
    }));
    verifySetupInferenceConfig.mockImplementationOnce(async ({ config }) => {
      expect(config.agents?.defaults?.experimental?.localModelLean).toBeUndefined();
      expect(replaceConfigFile).not.toHaveBeenCalled();
      return { ok: true, modelRef, latencyMs: 1 };
    });
    const prompter = buildWizardPrompter({ confirm: vi.fn(async () => true) });
    await runWizard({ authChoice: "demo-provider" }, createRuntime(), prompter);
    expect(prompter.confirm).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Test AI access now with a live completion?" }),
    );
    expect(verifySetupInferenceConfig).toHaveBeenCalledOnce();
    expect(
      persistedWizardConfigs().at(-1)?.agents?.defaults?.experimental?.localModelLean,
    ).toBeUndefined();
    expect(persistedWizardConfigs().at(-1)?.wizard ?? {}).not.toHaveProperty(
      "localModelLeanAutoModel",
    );
  });

  it("keeps the saved credential and leaves config unchanged when verification is cancelled", async () => {
    const stateDir = await makeCaseDir("cancelled-auth-verification-");
    const agentDir = path.join(stateDir, "agent");
    prepareMockAuthProfilesIn(agentDir);
    applyAuthChoice.mockResolvedValueOnce({
      config: modelConfigWithApiKey("test-cancelled-key", agentDir),
    });
    verifySetupInferenceConfig.mockImplementationOnce(async ({ config }) => {
      expectSavedSetupCredential(config, agentDir, "test-cancelled-key");
      expect(replaceConfigFile).not.toHaveBeenCalled();
      throw new WizardCancelledError("cancelled");
    });

    try {
      await expect(
        runWizard(
          { authChoice: "demo-provider" },
          createRuntime(),
          buildWizardPrompter({ confirm: vi.fn(async () => true) }),
        ),
      ).rejects.toThrow("cancelled");

      expect(replaceConfigFile).not.toHaveBeenCalled();
      expect(Object.values(readAuthProfileStoreForTest(agentDir).profiles)).toContainEqual({
        ...openAiAuthProfile("test-cancelled-key").credential,
        setup: expect.objectContaining({
          replacement: false,
          modelRef: "openai/gpt-5.5",
          configJson: expect.any(String),
        }),
      });
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it("saves each retry credential before verification while failed candidates leave config unchanged", async () => {
    const stateDir = await makeCaseDir("failed-auth-profile-retry-");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    await upsertAuthProfileWithLock({ ...openAiAuthProfile("test-original-key"), agentDir });
    prepareMockAuthProfilesIn(agentDir);
    applyAuthChoice
      .mockResolvedValueOnce({ config: modelConfigWithApiKey("test-original-key", agentDir) })
      .mockResolvedValueOnce({ config: modelConfigWithApiKey("test-retry-invalid-key", agentDir) })
      .mockResolvedValueOnce({
        config: modelConfigWithApiKey("test-retry-still-invalid-key", agentDir),
      });
    promptAuthChoiceGrouped.mockResolvedValue("demo-provider");
    queueCredentialVerification(agentDir, "test-original-key");
    queueCredentialVerification(agentDir, "test-retry-invalid-key");
    queueCredentialVerification(agentDir, "test-retry-still-invalid-key");
    const select = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce("fix")
      .mockResolvedValueOnce("fix")
      .mockResolvedValueOnce("continue") as unknown as WizardPrompter["select"];
    const prompter = buildWizardPrompter({ confirm: vi.fn(async () => true), select });

    try {
      await runWizard({ authChoice: "demo-provider" }, createRuntime(), prompter);

      expect(applyAuthChoice).toHaveBeenCalledTimes(3);
      expect(promptAuthChoiceGrouped).toHaveBeenCalledTimes(2);
      expect(verifySetupInferenceConfig).toHaveBeenCalledTimes(3);
      expectSavedSetupCredential(verifiedConfig(2), agentDir, "test-retry-still-invalid-key");
      const secondRetry = expectDefined(applyAuthChoice.mock.calls[2]?.[0], "expected call");
      expect(secondRetry.config.models?.providers?.openai?.apiKey).toBe("test-original-key");
      expect(select).toHaveBeenCalledTimes(4);
      expect(
        persistedWizardConfigs().some(
          (config) =>
            config.models?.providers?.openai?.apiKey === "test-original-key" ||
            config.models?.providers?.openai?.apiKey === "test-retry-invalid-key" ||
            config.models?.providers?.openai?.apiKey === "test-retry-still-invalid-key",
        ),
      ).toBe(false);
      expect(readAuthProfileStoreForTest(agentDir).profiles["openai:default"]).toEqual(
        openAiAuthProfile("test-original-key").credential,
      );
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it("reuses the saved retry credential when a later Fix keeps the current auth", async () => {
    const stateDir = await makeCaseDir("kept-auth-profile-retry-");
    const agentDir = path.join(stateDir, "agent");
    prepareMockAuthProfilesIn(agentDir);
    applyAuthChoice
      .mockResolvedValueOnce({ config: modelConfigWithApiKey("test-original-key", agentDir) })
      .mockResolvedValueOnce({ config: modelConfigWithApiKey("test-kept-retry-key", agentDir) });
    promptAuthChoiceGrouped
      .mockResolvedValueOnce("demo-provider")
      .mockResolvedValueOnce("__keep-current");
    queueCredentialVerification(agentDir, "test-original-key");
    queueCredentialVerification(agentDir, "test-kept-retry-key", {
      ok: false,
      status: "timeout",
      error: "request timed out",
    });
    queueCredentialVerification(agentDir, "test-kept-retry-key", {
      ok: true,
      modelRef: "openai/gpt-5.5",
      latencyMs: 300,
    });
    const select = vi.fn(async () => "fix") as unknown as WizardPrompter["select"];
    const prompter = buildWizardPrompter({ confirm: vi.fn(async () => true), select });

    try {
      await runWizard({ authChoice: "demo-provider" }, createRuntime(), prompter);

      expect(applyAuthChoice).toHaveBeenCalledTimes(2);
      expect(promptAuthChoiceGrouped).toHaveBeenCalledTimes(2);
      expect(verifySetupInferenceConfig).toHaveBeenCalledTimes(3);
      const selected = expectSavedSetupCredential(
        verifiedConfig(2),
        agentDir,
        "test-kept-retry-key",
      );
      expectSavedSetupCredential(
        expectDefined(persistedWizardConfigs().at(-1), "persisted wizard config"),
        agentDir,
        "test-kept-retry-key",
      );
      expect(expectSavedSetupCredential(verifiedConfig(1), agentDir, "test-kept-retry-key")).toBe(
        selected,
      );
      expect(Object.keys(readAuthProfileStoreForTest(agentDir).profiles)).toHaveLength(2);
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
