import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import {
  readAuthProfileStoreForTest,
  removeOAuthTestTempRoot,
} from "../agents/auth-profiles/oauth-test-utils.js";
import { upsertAuthProfileWithLock } from "../agents/auth-profiles/profiles.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import { committedConfigFiles } from "../commands/committed-config.test-support.js";
import { createConfigIO as createRealConfigIO } from "../config/io.factory.js";
import { createConfigFileSnapshot } from "../config/io.snapshot-shared.js";
import { materializeRuntimeConfig } from "../config/materialize.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginCompatibilityNotice } from "../plugins/status.js";
import type { RuntimeEnv } from "../runtime.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import type { WizardPrompter, WizardSelectParams } from "./prompts.js";
import {
  expectSavedSetupCredential,
  modelConfigWithApiKey,
  openAiAuthProfile,
} from "./setup.credentials.test-support.js";
import { runSetupWizard } from "./setup.js";
import { SetupMigrationTargetChangedError } from "./setup.migration-snapshot.js";

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

const m = vi.hoisted(() => {
  const applyAuth = vi.fn<ApplyAuthChoice>(async (args) => ({ config: args.config }));
  return {
    authStore: vi.fn(() => ({ profiles: {} })),
    promptAuth: vi.fn(async () => "skip"),
    applyAuth,
    prepareAuth: vi.fn<PrepareAuthChoice>(async (args) => ({
      ...(await applyAuth(args)),
      authProfiles: [],
      persistAuthProfiles: async () => {},
    })),
    authFlags: vi.fn<ResolveProviderOnboardAuthFlags>(() => []),
    providerChoice: vi.fn<ResolveProviderPluginChoice>(() => null),
    providers: vi.fn<
      typeof import("../plugins/provider-auth-choice.runtime.js").resolvePluginProviders
    >(() => []),
    warnModel: vi.fn(async () => {}),
    pickModel: vi.fn<PromptDefaultModel>(async () => ({})),
    gateway: vi.fn<ConfigureGatewayForSetup>(async (args) => ({
      nextConfig: args.nextConfig,
      settings: {
        port: args.quickstartGateway.port,
        bind: "loopback",
        authMode: "token",
        gatewayToken: "test-token",
      },
    })),
    finalize: vi.fn<typeof import("./setup.finalize.js").finalizeSetupWizard>(async () => ({
      launchedTui: false,
    })),
    migrationSources: vi.fn(async () => ({ detections: [], providerDescriptors: [] })),
    migrationOptions: vi.fn<ListSetupMigrationOptions>(async () => []),
    importMigration: vi.fn<RunSetupMigrationImport>(async () => ({
      kind: "no-imported-inference",
    })),
    importMemory: vi.fn(async () => {}),
    memory: vi.fn<typeof import("../flows/memory-setup.js").runMemorySetupFlow>(
      async (config) => config,
    ),
    verify: vi.fn<VerifySetupInferenceConfig>(async () => ({
      ok: true,
      modelRef: "openai/gpt-5.5",
      latencyMs: 250,
    })),
    channels: vi.fn<typeof import("../flows/channel-setup.js").setupChannels>(async (cfg) => cfg),
    search: vi.fn<RunSearchSetupFlow>(async (config) => ({ outcome: "completed", config })),
    remote: vi.fn<typeof import("../commands/onboard-remote.js").promptRemoteGatewayConfig>(
      async (cfg) => cfg,
    ),
    validateRemote: vi.fn<(value: string) => string | undefined>(() => undefined),
    workspace: vi.fn(async () => {}),
    onboarding: vi.fn(
      async ({ config, baseConfig }: { config: OpenClawConfig; baseConfig: OpenClawConfig }) => ({
        config,
        configBase: baseConfig,
        agentId: "main",
        bootstrapPending: true,
      }),
    ),
    writeConfig: vi.fn(async (params: { nextConfig: OpenClawConfig }) => ({
      nextConfig: params.nextConfig,
    })),
    port: vi.fn((_cfg?: unknown, env?: NodeJS.ProcessEnv) => {
      const raw = env?.OPENCLAW_GATEWAY_PORT ?? process.env.OPENCLAW_GATEWAY_PORT;
      const port = raw ? Number.parseInt(raw, 10) : Number.NaN;
      return Number.isFinite(port) && port > 0 ? port : 18789;
    }),
    readConfig: vi.fn<typeof import("../config/io.js").readConfigFileSnapshot>(),
    probe: vi.fn(async () => ({ ok: false })),
    compat: vi.fn((): PluginCompatibilityNotice[] => []),
  };
});

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
  return m.remote.mock.calls.map(([config, prompter, options]) => ({
    remote: config.gateway?.remote,
    prompter,
    options,
  }));
}

function modelConfig(primary: string): OpenClawConfig {
  return { agents: { defaults: { model: { primary } }, entries: { main: {} } } };
}

function prepareMockAuthProfilesIn(agentDir: string): void {
  m.prepareAuth.mockImplementation(async (args) => {
    const result = await m.applyAuth(args);
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
  m.verify.mockImplementationOnce(async ({ config }) => {
    expectSavedSetupCredential(config, agentDir, key);
    expect(m.writeConfig).not.toHaveBeenCalled();
    return result;
  });
}

function verifiedConfig(index: number): OpenClawConfig {
  return expectDefined(m.verify.mock.calls[index]?.[0], "verification call").config;
}

function persistedWizardConfigs(): OpenClawConfig[] {
  return m.writeConfig.mock.calls.map(([params]) => params.nextConfig);
}

function expectPartialCall(mock: unknown, shape: object) {
  expect(mock).toHaveBeenCalledWith(expect.objectContaining(shape));
}

function expectCalls(count: number, ...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).toHaveBeenCalledTimes(count);
  }
}

vi.mock("../flows/channel-setup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../flows/channel-setup.js")>()),
  setupChannels: m.channels,
}));

vi.mock("../flows/search-setup.js", () => ({ runSearchSetupFlow: m.search }));
// mock-isolation: Wizard orchestration must not probe real embedding providers or credentials.
vi.mock("../flows/memory-setup.js", () => ({ runMemorySetupFlow: m.memory }));

vi.mock("../commands/onboard-remote.js", () => ({
  promptRemoteGatewayConfig: m.remote,
  validateGatewayWebSocketUrl: m.validateRemote,
}));

vi.mock("../agents/auth-profiles.js", async () => {
  const persistence = await import("../agents/auth-profiles/upsert-with-lock.js");
  return {
    ensureAuthProfileStore: m.authStore,
    persistAuthProfileBatch: persistence.persistAuthProfileBatch,
  };
});

vi.mock("../agents/auth-profiles.runtime.js", () => ({ ensureAuthProfileStore: m.authStore }));

vi.mock("../commands/auth-choice-prompt.js", () => ({
  isKeepCurrentAuthChoice: (value: unknown) => value === "__keep-current",
  promptAuthChoiceGrouped: m.promptAuth,
}));

vi.mock("../commands/auth-choice.apply.js", () => ({
  applyAuthChoice: m.applyAuth,
  prepareAuthChoice: m.prepareAuth,
}));

vi.mock("../plugins/provider-auth-choice-preference.js", () => ({
  resolvePreferredProviderForAuthChoice: async () => "demo-provider",
}));

vi.mock("../commands/auth-choice.model-check.js", () => ({
  warnIfModelConfigLooksOff: m.warnModel,
}));

vi.mock("../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoice: () => undefined,
  resolveManifestProviderAuthChoices: () => [],
  resolveProviderOnboardAuthFlags: m.authFlags,
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
  resolveProviderPluginChoice: m.providerChoice,
  resolvePluginProviders: m.providers,
}));

vi.mock("../flows/model-picker.js", () => ({ promptDefaultModel: m.pickModel }));

vi.mock("./setup.migration-import.js", () => ({
  detectSetupMigrationSources: m.migrationSources,
  listSetupMigrationOptions: m.migrationOptions,
  runSetupMigrationImport: m.importMigration,
}));

vi.mock("./setup.memory-import.js", () => ({ runSetupMemoryImportStep: m.importMemory }));

vi.mock("../system-agent/setup-inference.js", () => ({ verifySetupInferenceConfig: m.verify }));

vi.mock("../config/config.js", async (importActual) => {
  const actual = await importActual<typeof import("../config/config.js")>();
  return {
    ...actual,
    DEFAULT_GATEWAY_PORT: 18789,
    createConfigIO: () => ({ readConfigFileSnapshot: m.readConfig }),
    readConfigFileSnapshot: m.readConfig,
    resolveGatewayPort: m.port,
    replaceConfigFile: m.writeConfig,
    transformConfigFileWithRetry: async (
      params: Parameters<typeof actual.transformConfigFileWithRetry>[0],
    ) => {
      const snapshot = await m.readConfig();
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
vi.mock("./setup.shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./setup.shared.js")>()),
  readSetupConfigAuthority: async () => ({
    snapshot: await m.readConfig(),
    assertCurrent: () => {},
  }),
}));
// mock-isolation: Keep roster/database creation and session migration outside these in-memory fixtures.
vi.mock("../commands/onboard-agent.js", () => ({
  ensureOnboardingAgent: m.onboarding,
  validateFirstOnboardingAgentName: (value: string | undefined) =>
    value?.trim() ? undefined : "Agent name is required.",
}));
vi.mock("../commands/onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "/tmp/openclaw-workspace",
  applyWizardMetadata: (cfg: unknown) => cfg,
  summarizeExistingConfig: () => "summary",
  ensureWorkspaceAndSessions: m.workspace,
  printWizardHeader: vi.fn(),
  probeGatewayReachable: m.probe,
}));

vi.mock("../plugins/status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/status.js")>()),
  buildPluginCompatibilitySnapshotNotices: m.compat,
}));

// mock-isolation: Keep process-global channel registry state outside wizard orchestration fixtures.
vi.mock("../channels/plugins/index.js", () => ({ listChannelPlugins: () => [] }));

vi.mock("./setup.gateway-config.js", () => ({ configureGatewayForSetup: m.gateway }));

vi.mock("./setup.finalize.js", () => ({ finalizeSetupWizard: m.finalize }));

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

let runtime: RuntimeEnv;
let prompter: WizardPrompter;

function runWizard(options: Parameters<typeof runSetupWizard>[0] = {}) {
  return runSetupWizard({ ...defaultSetupOptions, ...options }, runtime, prompter);
}

function runRemoteWizard(options: Parameters<typeof runSetupWizard>[0]) {
  return runSetupWizard(
    { acceptRisk: true, flow: "advanced", mode: "remote", ...options },
    runtime,
    prompter,
  );
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
    const sourceConfig = createCanonicalAgentConfigFixture(config).config;
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
    m.readConfig.mockImplementation(async () =>
      configSnapshot(persistedWizardConfigs().at(-1) ?? existingConfig),
    );
  }

  function readConfig(config: OpenClawConfig, imported = false) {
    if (imported) {
      m.readConfig.mockResolvedValueOnce(configSnapshot({}, false));
      m.readConfig.mockResolvedValue(configSnapshot(config));
    } else {
      m.readConfig.mockResolvedValueOnce(configSnapshot(config));
    }
  }

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", undefined);
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", undefined);
    vi.resetAllMocks();
    runtime = createRuntime();
    prompter = buildWizardPrompter();
    committedConfigFiles.clear();
    let authoredConfig: OpenClawConfig | undefined;
    m.readConfig.mockImplementation(async () =>
      configSnapshot(authoredConfig ?? {}, authoredConfig !== undefined),
    );
    m.writeConfig.mockImplementation(async (params) => {
      authoredConfig = structuredClone(params.nextConfig);
      return { nextConfig: params.nextConfig };
    });
  });

  it("exits successfully after the auto-launched TUI returns", async () => {
    m.finalize.mockResolvedValueOnce({ launchedTui: true });
    runtime = createRuntime({ throwsOnExit: true });
    await expect(runWizard()).rejects.toThrow("exit:0");
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
    readConfig({ gateway: { remote: storedRemote() } });
    if (remoteKey === "password") {
      vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "ambient-gateway-token");
    }
    await runRemoteWizard({
      remoteUrl: " wss://flag.example.com:18789 ",
      [optionKey]: ` ${remoteCredential} `,
    });
    expect(m.probe).toHaveBeenCalledWith({
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
    expect(m.remote.mock.calls[0]?.[2]).toStrictEqual({
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
    readConfig({ gateway: { remote } });
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "ambient-password"); // pragma: allowlist secret
    await runRemoteWizard({ remoteUrl: "wss://flag.example.com:18789" });
    expect(m.probe).toHaveBeenCalledWith({
      ...configuredRemoteProbeArgs,
      configuredRemote: false,
      url: "wss://flag.example.com:18789",
      config: expect.objectContaining({ gateway: expect.objectContaining({ remote }) }),
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
    m.validateRemote.mockReturnValueOnce("Use wss:// for public gateways");
    await runRemoteWizard({ remoteUrl: "ws://public.example", remoteToken });
    expect(m.validateRemote).toHaveBeenCalledWith("ws://public.example");
    expect(m.probe).not.toHaveBeenCalledWith(
      expect.objectContaining({ url: "ws://public.example" }),
    );
  });

  it("leaves feature-stat telemetry unset during non-interactive wizard setup", async () => {
    runtime = createRuntime({ throwsOnExit: true });
    await runWizard({ nonInteractive: true });
    expect(persistedWizardConfigs().at(-1)?.telemetry).toBeUndefined();
    expect(prompter.select).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Help make OpenClaw better?" }),
    );
  });

  it.each(["target-change", "back"] as const)(
    "returns to setup mode after import %s",
    async (result) => {
      m.migrationOptions.mockResolvedValueOnce([
        { providerId: "hermes", label: "Import from Hermes" },
      ]);
      if (result === "target-change") {
        m.importMigration.mockRejectedValueOnce(
          new SetupMigrationTargetChangedError(
            "Migration target changed before promotion. Review it and retry.",
          ),
        );
      } else {
        m.importMigration.mockResolvedValueOnce({ kind: "back" });
      }
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
      prompter = buildWizardPrompter({
        select: select as unknown as WizardPrompter["select"],
      });
      await runWizard({ flow: undefined });
      expect(select.mock.calls.filter(([params]) => params.message === "Setup mode")).toHaveLength(
        2,
      );
      expectCalls(1, m.migrationSources, m.importMigration);
      if (result === "target-change") {
        expect(prompter.note).toHaveBeenCalledWith(
          expect.stringContaining("Migration target changed before promotion"),
          "Existing config detected",
        );
      }
      expect(m.finalize).toHaveBeenCalledOnce();
    },
  );

  it("continues onboarding after a recovered promotion", async () => {
    const acknowledgePromotion = vi.fn(async () => {});
    m.importMigration.mockResolvedValueOnce({
      kind: "no-imported-inference",
      acknowledgePromotion,
    });
    await runWizard({ importFrom: "hermes" });
    expectCalls(1, m.finalize, acknowledgePromotion);
    expect(m.importMemory).not.toHaveBeenCalled();
  });

  it("rejects an agent name when the import supplies an authored roster", async () => {
    const workspaceDir = await fs.realpath(await makeCaseDir("import-naming-"));
    const configPath = path.join(workspaceDir, "openclaw.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({ agents: { entries: { main: {} }, defaults: { workspace: workspaceDir } } }),
    );
    const importedSnapshot = await createRealConfigIO({
      configPath,
      pluginValidation: "skip",
    }).readConfigFileSnapshot();
    expect(importedSnapshot.valid).toBe(true);
    m.readConfig
      .mockResolvedValueOnce(configSnapshot({}, false))
      .mockResolvedValue(importedSnapshot);
    prompter = buildWizardPrompter({ text: vi.fn(async () => "robby") });
    await runWizard({ importFrom: "hermes", agentName: "robby", workspace: workspaceDir });
    expect(m.importMigration).toHaveBeenCalledOnce();
    expect(runtime.error).toHaveBeenCalledWith(
      "--agent-name cannot be combined with an import that supplies an agent roster. Remove --agent-name or choose an import without agents.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(m.onboarding).not.toHaveBeenCalled();
    expect(prompter.text).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "What should we call your first agent?" }),
    );
  });

  it("does not reuse imported verification after changing the model", async () => {
    m.importMigration.mockResolvedValueOnce({
      kind: "verified-inference",
      modelRef: "openai/gpt-5.6-sol",
    });
    readConfig(modelConfig("anthropic/claude-sonnet-4-6"), true);
    prompter = buildWizardPrompter({ confirm: vi.fn(async () => false) });
    await runWizard({ importFrom: "hermes", authChoice: "demo-provider" });
    expect(m.applyAuth).toHaveBeenCalledOnce();
    expect(m.verify).not.toHaveBeenCalled();
  });

  it("treats --import-source alone as import intent instead of prompting for a setup mode", async () => {
    await runWizard({ importSource: "~/.hermes", flow: undefined });
    expect(m.importMigration).toHaveBeenCalledOnce();
    expectPartialCall(m.importMigration, {
      opts: expect.objectContaining({ importSource: "~/.hermes" }),
    });
    expect(prompter.select).toHaveBeenCalledOnce();
    expectPartialCall(prompter.select, {
      message: "Help make OpenClaw better?",
      initialValue: false,
    });
  });

  it("fails fast if the auth choice prompt returns nothing", async () => {
    m.promptAuth.mockImplementationOnce(async () => undefined as never);
    await expect(runWizard({ authChoice: undefined })).rejects.toThrow("auth choice is required");
  });

  it.each([false, true])(
    "moves a fleet workspace only with confirmation (accepted: %s)",
    async (accepted) => {
      const currentWorkspace = await makeCaseDir("fleet-current-");
      const requestedWorkspace = await makeCaseDir("fleet-requested-");
      const config: OpenClawConfig = {
        ...(accepted ? { wizard: { securityAcknowledgedAt: "2026-06-30T00:00:00.000Z" } } : {}),
        agents: {
          ownership: "explicit",
          defaults: { workspace: currentWorkspace, systemAgent: { agentId: "main" } },
          entries: { main: {}, ops: {} },
        },
      };
      readConfig(config, !accepted);
      const confirm = vi.fn(async () => accepted);
      prompter = buildWizardPrompter({ confirm });
      await runWizard({
        workspace: requestedWorkspace,
        ...(!accepted ? { importFrom: "hermes" } : {}),
      });
      expectPartialCall(confirm, {
        message: expect.stringContaining("Move the existing agent fleet"),
        initialValue: false,
      });
      const final = persistedWizardConfigs().at(-1)?.agents;
      expect(final?.defaults?.workspace).toBe(accepted ? requestedWorkspace : currentWorkspace);
      if (accepted) {
        expect(vi.mocked(prompter.note).mock.calls.flat().join("\n")).toContain(currentWorkspace);
        expect(m.workspace).toHaveBeenCalledWith(
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
    m.search.mockResolvedValueOnce({
      outcome: "install-failed",
      config,
      providerId: "brave",
      reason: "failed",
    });
    readConfig(config);
    await runWizard({ skipSearch: undefined });
    expectCalls(1, m.search, m.finalize);
  });

  it("persists the optional memory choice before classic setup finalization", async () => {
    runMemorySetupFlow.mockImplementationOnce(async (config) => ({
      ...config,
      memory: { search: { provider: "openai", model: "embedding-model" } },
    }));
    await runWizard();
    expect(runMemorySetupFlow).toHaveBeenCalledOnce();
    expect(persistedWizardConfigs().at(-1)?.memory?.search).toEqual({
      provider: "openai",
      model: "embedding-model",
    });
    expect(runMemorySetupFlow.mock.invocationCallOrder[0]).toBeLessThan(
      finalizeSetupWizard.mock.invocationCallOrder[0]!,
    );
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
    m.channels.mockImplementationOnce(async (_cfg, _runtime, _prompter, options) => {
      options?.onPostWriteHook?.({ channel: "matrix", accountId: "ops", run: hook });
      return configured;
    });
    readConfig(beforeConfig);
    await runWizard({ skipChannels: undefined });
    const configuredWriteIndex = m.writeConfig.mock.calls.findIndex(([params]) =>
      isConfiguredWrite(params.nextConfig),
    );
    expect(configuredWriteIndex).toBeGreaterThanOrEqual(0);
    expect(m.writeConfig.mock.invocationCallOrder[configuredWriteIndex]).toBeLessThan(
      hook.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(hook).toHaveBeenCalledWith({ cfg: configured, runtime: expect.any(Object) });
    expect(hook.mock.invocationCallOrder[0]).toBeLessThan(
      m.finalize.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("honors a provider-required picker while keeping existing model settings", async () => {
    const modelSelection = { promptWhenAuthChoiceProvided: true, allowKeepCurrent: false };
    m.pickModel.mockResolvedValueOnce({ model: "ollama/llama3" });
    m.providerChoice.mockReturnValue({
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
    prompter = buildWizardPrompter({}, { defaultSelect: "keep-model" });
    await runWizard({ authChoice: "ollama", flow: undefined });
    expectPartialCall(m.pickModel, { allowKeep: false });
    expect(m.prepareAuth).toHaveBeenCalledOnce();
    expect(persistedWizardConfigs().at(-1)?.agents?.defaults?.model).toEqual({
      primary: "ollama/llama3",
    });
  });

  it("infers an API-key flag while preserving an existing default model", async () => {
    m.providers.mockReturnValueOnce([
      { id: "", label: "Empty", auth: [] },
      { id: "demo-provider", label: "Demo", auth: [], wizard: { setup: {} } },
    ]);
    m.authFlags.mockReturnValue([
      providerFlag("nvidiaApiKey", "nvidia-api-key", "--nvidia-api-key"),
    ]);
    readExistingModel();
    prompter = buildWizardPrompter({}, { defaultSelect: "keep-model" });
    await runWizard({
      nvidiaApiKey: "provider-credential-fixture",
      flow: undefined,
      authChoice: undefined,
    });
    expectPartialCall(m.prepareAuth, {
      authChoice: "nvidia-api-key",
      opts: expect.objectContaining({ nvidiaApiKey: "provider-credential-fixture" }),
    });
    expect(persistedWizardConfigs().at(-1)?.agents?.defaults?.model).toEqual({
      primary: "anthropic/sonnet-4.6",
    });
    expect(m.pickModel).not.toHaveBeenCalled();
  });

  it("rejects ambiguous provider credential flags before writing local setup state", async () => {
    m.authFlags.mockReturnValue([
      providerFlag("nvidiaApiKey", "nvidia-api-key", "--nvidia-api-key"),
      providerFlag("githubCopilotToken", "github-copilot", "--github-copilot-token"),
    ]);
    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        nvidiaApiKey: "nvidia-credential-fixture",
        githubCopilotToken: "copilot-credential-fixture",
      },
      runtime,
      prompter,
    );
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Multiple provider credential flags"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expectCalls(0, m.prepareAuth, m.onboarding, m.writeConfig);
  });

  it("re-prompts for auth when applyAuthChoice requests retry selection", async () => {
    m.promptAuth.mockReset();
    m.promptAuth
      .mockResolvedValueOnce("demo-provider-one")
      .mockResolvedValueOnce("demo-provider-two");
    m.applyAuth.mockReset();
    m.applyAuth
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
    expectCalls(2, m.promptAuth, m.applyAuth);
    const retry = m.applyAuth.mock.calls[1]?.[0];
    expect(retry?.authChoice).toBe("demo-provider-two");
    expect(retry?.config.plugins?.entries).toEqual({ "demo-provider-plugin": { enabled: true } });
    expect(retry?.config.agents?.entries).toEqual({ main: {} });
    expect(retry?.config.agents?.defaults?.workspace).toBe("/tmp/openclaw-workspace");
  });

  it("shows plugin compatibility notices for an existing valid config", async () => {
    m.compat.mockReturnValue([
      {
        pluginId: "legacy-plugin",
        code: "hook-only",
        compatCode: "hook-only-plugin-shape",
        severity: "info",
        message: "uses legacy hooks",
      },
    ]);
    readConfig({ gateway: {} });
    await runWizard();
    const { note, select } = prompter;
    expect(vi.mocked(note).mock.calls.map((call) => call[1])).toEqual(
      expect.arrayContaining(["Plugin compatibility", "Existing config detected"]),
    );
    expect(select).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Config handling" }),
    );
    expect(note).toHaveBeenCalledWith(expect.stringContaining("legacy-plugin"), expect.anything());
  });

  it("resolves gateway.auth.password SecretRef for local setup probe", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "gateway-ref-password");
    readConfig({
      gateway: {
        auth: {
          mode: "password",
          password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
        },
      },
    });
    await runWizard({ mode: "local" });
    expectPartialCall(m.probe, {
      url: "ws://127.0.0.1:18789",
      password: "gateway-ref-password",
    });
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
      if (flow === "quickstart") {
        m.readConfig.mockResolvedValueOnce(
          configSnapshot({
            agents: { entries: { main: {} } },
            gateway: {
              port: 19111,
              bind: "loopback",
              auth: { mode: "token", token: "stored-token" },
              tailscale: { mode: "off" },
            },
          }),
        );
        m.gateway.mockImplementationOnce(async ({ nextConfig, quickstartGateway: gateway }) => ({
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
          },
        }));
      }
      await runWizard({
        flow,
        mode: "local",
        gatewayPort: port,
        gatewayBind: "lan",
        gatewayAuth: "password",
        gatewayPassword: password,
        ...(flow === "advanced" ? { gatewayToken: token, tailscale: "off" } : {}),
      });
      const quickstartGateway = { port, bind: "lan", authMode: "password", password };
      expect(m.gateway.mock.calls[0]?.[0].quickstartGateway).toMatchObject(quickstartGateway);
      if (flow === "advanced") {
        expectPartialCall(m.probe, {
          url: `ws://127.0.0.1:${port}`,
          token,
          password,
        });
        expect(m.gateway.mock.calls[0]?.[0]).toMatchObject({
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

  it.each(["failed candidates leave config unchanged", "Fix keeps the current auth"])(
    "saves retry credentials before verification when %s",
    async (scenario) => {
      const keep = scenario === "Fix keeps the current auth";
      const stateDir = await makeCaseDir("auth-profile-retry-");
      const agentDir = keep
        ? path.join(stateDir, "agent")
        : path.join(stateDir, "agents", "main", "agent");
      const keys = keep
        ? (["test-original-key", "test-kept-retry-key"] as const)
        : ([
            "test-original-key",
            "test-retry-invalid-key",
            "test-retry-still-invalid-key",
          ] as const);
      if (!keep) {
        await upsertAuthProfileWithLock({ ...openAiAuthProfile(keys[0]), agentDir });
      }
      prepareMockAuthProfilesIn(agentDir);
      for (const key of keys) {
        m.applyAuth.mockResolvedValueOnce({ config: modelConfigWithApiKey(key, agentDir) });
      }
      m.promptAuth.mockResolvedValue("demo-provider");
      queueCredentialVerification(agentDir, keys[0]);
      if (keep) {
        m.promptAuth.mockResolvedValueOnce("demo-provider").mockResolvedValueOnce("__keep-current");
        queueCredentialVerification(agentDir, keys[1], {
          ok: false,
          status: "timeout",
          error: "request timed out",
        });
        queueCredentialVerification(agentDir, keys[1], {
          ok: true,
          modelRef: "openai/gpt-5.5",
          latencyMs: 300,
        });
      } else {
        keys.slice(1).forEach((key) => queueCredentialVerification(agentDir, key));
      }
      prompter = buildWizardPrompter(
        {
          confirm: vi.fn(async () => true),
          ...(keep
            ? { select: vi.fn(async () => "fix") as unknown as WizardPrompter["select"] }
            : {}),
        },
        { selectValues: ["fix", "fix", "continue"] },
      );
      try {
        await runWizard({ authChoice: "demo-provider" });
        expect(m.applyAuth).toHaveBeenCalledTimes(keys.length);
        expect(m.promptAuth).toHaveBeenCalledTimes(2);
        expect(m.verify).toHaveBeenCalledTimes(3);
        const selected = expectSavedSetupCredential(
          verifiedConfig(2),
          agentDir,
          expectDefined(keys.at(-1), "retry key"),
        );
        if (keep) {
          expectSavedSetupCredential(
            expectDefined(persistedWizardConfigs().at(-1), "persisted wizard config"),
            agentDir,
            keys[1],
          );
          expect(expectSavedSetupCredential(verifiedConfig(1), agentDir, keys[1])).toBe(selected);
          expect(Object.keys(readAuthProfileStoreForTest(agentDir).profiles)).toHaveLength(2);
        } else {
          expect(
            expectDefined(m.applyAuth.mock.calls[2]?.[0], "expected call").config.models?.providers
              ?.openai?.apiKey,
          ).toBe(keys[0]);
          expect(prompter.select).toHaveBeenCalledTimes(4);
          expect(
            persistedWizardConfigs().some((config) =>
              keys.some((key) => config.models?.providers?.openai?.apiKey === key),
            ),
          ).toBe(false);
          expect(readAuthProfileStoreForTest(agentDir).profiles["openai:default"]).toEqual(
            openAiAuthProfile(keys[0]).credential,
          );
        }
      } finally {
        await removeOAuthTestTempRoot(stateDir);
      }
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
