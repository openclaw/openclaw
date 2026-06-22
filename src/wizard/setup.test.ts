// Setup wizard tests cover end-to-end onboarding prompt flows.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createWizardPrompter as buildWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { DEFAULT_BOOTSTRAP_FILENAME } from "../agents/workspace.js";
import type { PluginCompatibilityNotice } from "../plugins/status.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter, WizardSelectParams } from "./prompts.js";
import { runSetupWizard } from "./setup.js";

type ResolveProviderPluginChoice =
  typeof import("../plugins/provider-auth-choice.runtime.js").resolveProviderPluginChoice;
type ResolvePluginProvidersRuntime =
  typeof import("../plugins/provider-auth-choice.runtime.js").resolvePluginProviders;
type ResolvePluginSetupProvider =
  typeof import("../plugins/provider-auth-choice.runtime.js").resolvePluginSetupProvider;
type ResolveManifestProviderAuthChoice =
  typeof import("../plugins/provider-auth-choices.js").resolveManifestProviderAuthChoice;
type PromptDefaultModel = typeof import("../commands/model-picker.js").promptDefaultModel;
type ApplyAuthChoice = typeof import("../commands/auth-choice.js").applyAuthChoice;
type ListSetupMigrationOptions =
  typeof import("./setup.migration-import.js").listSetupMigrationOptions;
type DefaultGatewayBindMode = typeof import("../gateway/net.js").defaultGatewayBindMode;
type ApplyPrimaryModel = typeof import("../plugins/provider-model-primary.js").applyPrimaryModel;
type PromptCustomApiConfig = typeof import("../commands/onboard-custom.js").promptCustomApiConfig;

const ensureAuthProfileStore = vi.hoisted(() => vi.fn(() => ({ profiles: {} })));
const promptAuthChoiceGrouped = vi.hoisted(() => vi.fn(async () => "skip"));
const applyAuthChoice = vi.hoisted(() =>
  vi.fn<ApplyAuthChoice>(async (args) => ({ config: args.config })),
);
const resolvePreferredProviderForAuthChoice = vi.hoisted(() => vi.fn(async () => "demo-provider"));
const resolveManifestProviderAuthChoice = vi.hoisted(() =>
  vi.fn<ResolveManifestProviderAuthChoice>(() => undefined),
);
const resolvePluginSetupProvider = vi.hoisted(() =>
  vi.fn<ResolvePluginSetupProvider>(() => undefined),
);
const resolveProviderPluginChoice = vi.hoisted(() =>
  vi.fn<ResolveProviderPluginChoice>(() => null),
);
const resolvePluginProvidersRuntime = vi.hoisted(() =>
  vi.fn<ResolvePluginProvidersRuntime>(() => []),
);
const warnIfModelConfigLooksOff = vi.hoisted(() => vi.fn(async () => {}));
const applyPrimaryModel = vi.hoisted(() => vi.fn<ApplyPrimaryModel>((cfg) => cfg));
const promptDefaultModel = vi.hoisted(() => vi.fn<PromptDefaultModel>(async () => ({})));
const promptCustomApiConfig = vi.hoisted(() =>
  vi.fn<PromptCustomApiConfig>(async (args) => ({ config: args.config })),
);
const promptRemoteGatewayConfig = vi.hoisted(() => vi.fn(async (config) => config));
const configureGatewayForSetup = vi.hoisted(() =>
  vi.fn(async (args) => ({
    nextConfig: args.nextConfig,
    settings: {
      port: args.localPort ?? 18789,
      bind: "loopback",
      authMode: "token",
      gatewayToken: "test-token",
      tailscaleMode: "off",
      tailscaleResetOnExit: false,
    },
  })),
);
const finalizeSetupWizard = vi.hoisted(() =>
  vi.fn(async (options) => {
    if (!options.nextConfig?.tools?.web?.search?.provider) {
      await options.prompter.note("Web search was skipped.", "Web search");
    }

    if (options.opts.skipUi) {
      return { launchedTui: false };
    }

    const hatch = await options.prompter.select({
      message: "How do you want to hatch your agent?",
      options: [],
    });
    if (hatch !== "tui") {
      return { launchedTui: false };
    }

    let message: string | undefined;
    try {
      await fs.stat(path.join(options.workspaceDir, DEFAULT_BOOTSTRAP_FILENAME));
      message = "Wake up, my friend!";
    } catch {
      message = undefined;
    }

    await runTui({ local: true, deliver: false, message });
    return { launchedTui: true };
  }),
);
const listChannelPlugins = vi.hoisted(() => vi.fn(() => []));
const logConfigUpdated = vi.hoisted(() => vi.fn(() => {}));
const setupInternalHooks = vi.hoisted(() => vi.fn(async (cfg) => cfg));
const detectSetupMigrationSources = vi.hoisted(() => vi.fn(async () => []));
const listSetupMigrationOptions = vi.hoisted(() =>
  vi.fn<ListSetupMigrationOptions>(async () => []),
);
const isSetupMigrationTargetFresh = vi.hoisted(() => vi.fn(async () => true));
const runSetupMigrationImport = vi.hoisted(() => vi.fn(async () => {}));
const hasRunnableLocalAgent = vi.hoisted(() => vi.fn(async () => false));
const finishAgentAssistedSetup = vi.hoisted(() => vi.fn(async () => {}));
const defaultGatewayBindMode = vi.hoisted(() => vi.fn<DefaultGatewayBindMode>(() => "loopback"));
const resolveControlUiLinks = vi.hoisted(() =>
  vi.fn(() => ({
    httpUrl: "http://127.0.0.1:18789",
    wsUrl: "ws://127.0.0.1:18789",
  })),
);

const setupChannels = vi.hoisted(() => vi.fn(async (cfg) => cfg));
const setupSkills = vi.hoisted(() => vi.fn(async (cfg) => cfg));

function providerPluginStub(
  overrides: Partial<ProviderPlugin> & Pick<ProviderPlugin, "id">,
): ProviderPlugin {
  const { id, ...rest } = overrides;
  return {
    id,
    label: id || "provider",
    auth: [],
    ...rest,
  };
}
const healthCommand = vi.hoisted(() => vi.fn(async () => {}));
const ensureWorkspaceAndSessions = vi.hoisted(() => vi.fn(async () => {}));
const replaceConfigFile = vi.hoisted(() => vi.fn(async () => ({ config: {} })));
const resolveGatewayPort = vi.hoisted(() =>
  vi.fn((_cfg?: unknown, env?: NodeJS.ProcessEnv) => {
    const raw = env?.OPENCLAW_GATEWAY_PORT ?? process.env.OPENCLAW_GATEWAY_PORT;
    const port = raw ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(port) && port > 0 ? port : 18789;
  }),
);
const readConfigFileSnapshot = vi.hoisted(() =>
  vi.fn(async () => ({
    path: "/tmp/.openclaw/openclaw.json",
    exists: false,
    raw: null as string | null,
    parsed: {},
    resolved: {},
    valid: true,
    config: {},
    issues: [] as Array<{ path: string; message: string }>,
    warnings: [] as Array<{ path: string; message: string }>,
    legacyIssues: [] as Array<{ path: string; message: string }>,
  })),
);
const createConfigIO = vi.hoisted(() =>
  vi.fn(() => ({
    readConfigFileSnapshot,
  })),
);
const ensureSystemdUserLingerInteractive = vi.hoisted(() => vi.fn(async () => {}));
const isSystemdUserServiceAvailable = vi.hoisted(() => vi.fn(async () => true));
const ensureControlUiAssetsBuilt = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const runTui = vi.hoisted(() => vi.fn(async (_options: unknown) => {}));
const setupWizardShellCompletion = vi.hoisted(() => vi.fn(async () => {}));
const probeGatewayReachable = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const buildPluginCompatibilitySnapshotNotices = vi.hoisted(() =>
  vi.fn((): PluginCompatibilityNotice[] => []),
);
const formatPluginCompatibilityNotice = vi.hoisted(() =>
  vi.fn((notice: PluginCompatibilityNotice) => `${notice.pluginId} ${notice.message}`),
);

function getWizardNoteCalls(note: WizardPrompter["note"]) {
  return (note as unknown as { mock: { calls: unknown[][] } }).mock.calls;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(
  value: unknown,
  expected: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], `${label}.${key}`).toEqual(expectedValue);
  }
  return record;
}

function getMockCallArg(
  mock: { mock: { calls: readonly unknown[][] } },
  callIndex: number,
  argIndex: number,
  label: string,
): unknown {
  const call = (mock.mock.calls as unknown[][])[callIndex];
  if (!call) {
    throw new Error(`expected ${label} call ${callIndex}`);
  }
  return call[argIndex];
}

function expectMockCallArgNotNull(
  mock: { mock: { calls: readonly unknown[][] } },
  callIndex: number,
  argIndex: number,
  label: string,
): void {
  const value = getMockCallArg(mock, callIndex, argIndex, label);
  if (value === null) {
    throw new Error(`expected ${label} arg ${argIndex} to be non-null`);
  }
}

vi.mock("../commands/onboard-channels.js", () => ({
  setupChannels,
}));

vi.mock("../commands/onboard-skills.js", () => ({
  setupSkills,
}));

vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore,
}));

vi.mock("../agents/auth-profiles.runtime.js", () => ({
  ensureAuthProfileStore,
}));

vi.mock("../commands/auth-choice-prompt.js", () => ({
  promptAuthChoiceGrouped,
}));

vi.mock("../commands/auth-choice.js", () => ({
  applyAuthChoice,
  resolvePreferredProviderForAuthChoice,
  warnIfModelConfigLooksOff,
}));

vi.mock("../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoice,
}));

vi.mock("../plugins/setup-registry.js", () => ({
  resolvePluginSetupProvider,
}));

vi.mock("../plugins/provider-auth-choice.runtime.js", () => ({
  resolveProviderPluginChoice,
  resolvePluginProviders: resolvePluginProvidersRuntime,
}));

vi.mock("../commands/model-picker.js", () => ({
  applyPrimaryModel,
  promptDefaultModel,
}));

vi.mock("../commands/onboard-custom.js", () => ({
  promptCustomApiConfig,
}));

vi.mock("../commands/onboard-remote.js", () => ({
  promptRemoteGatewayConfig,
}));

vi.mock("../commands/health.js", () => ({
  healthCommand,
}));

vi.mock("../commands/onboard-hooks.js", () => ({
  setupInternalHooks,
}));

vi.mock("./setup.migration-import.js", () => ({
  detectSetupMigrationSources,
  isSetupMigrationTargetFresh,
  listSetupMigrationOptions,
  runSetupMigrationImport,
}));

vi.mock("./setup.assisted.js", () => ({
  finishAgentAssistedSetup,
  hasExplicitFullWizardIntent: vi.fn(
    (opts: {
      authChoice?: string;
      gatewayPort?: number;
      installDaemon?: boolean;
      mode?: string;
      reset?: boolean;
    }) =>
      opts.authChoice === "skip" ||
      opts.gatewayPort !== undefined ||
      opts.installDaemon !== undefined ||
      opts.mode !== undefined ||
      opts.reset === true,
  ),
  hasRunnableLocalAgent,
}));

vi.mock("../config/config.js", () => ({
  DEFAULT_GATEWAY_PORT: 18789,
  createConfigIO,
  resolveGatewayPort,
  replaceConfigFile,
}));

vi.mock("../gateway/net.js", () => ({
  defaultGatewayBindMode,
  isLoopbackAddress: (value: string | undefined) =>
    value === "::1" || value === "localhost" || value?.startsWith("127.") === true,
}));

vi.mock("../commands/onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "/tmp/openclaw-workspace",
  applyWizardMetadata: (cfg: unknown) => cfg,
  summarizeExistingConfig: () => "summary",
  handleReset: async () => {},
  randomToken: () => "test-token",
  normalizeGatewayTokenInput: (value: unknown) => ({
    ok: true,
    token: typeof value === "string" ? value.trim() : "",
    error: null,
  }),
  validateGatewayPasswordInput: () => ({ ok: true, error: null }),
  ensureWorkspaceAndSessions,
  detectBrowserOpenSupport: vi.fn(async () => ({ ok: false })),
  openUrl: vi.fn(async () => true),
  printWizardHeader: vi.fn(),
  probeGatewayReachable,
  waitForGatewayReachable: vi.fn(async () => {}),
  formatControlUiSshHint: vi.fn(() => "ssh hint"),
  resolveControlUiLinks,
}));

vi.mock("../commands/systemd-linger.js", () => ({
  ensureSystemdUserLingerInteractive,
}));

vi.mock("../daemon/systemd.js", () => ({
  isSystemdUserServiceAvailable,
}));

vi.mock("../infra/control-ui-assets.js", () => ({
  ensureControlUiAssetsBuilt,
}));

vi.mock("../plugins/status.js", () => ({
  buildPluginCompatibilitySnapshotNotices,
  formatPluginCompatibilityNotice,
}));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins,
}));

vi.mock("../config/logging.js", () => ({
  logConfigUpdated,
}));

vi.mock("../tui/tui.js", () => ({
  runTui,
}));

vi.mock("./setup.gateway-config.js", () => ({
  configureGatewayForSetup,
}));

vi.mock("./setup.finalize.js", () => ({
  finalizeSetupWizard,
}));

vi.mock("./setup.completion.js", () => ({
  setupWizardShellCompletion,
}));

function createRuntime(opts?: { throwsOnExit?: boolean }): RuntimeEnv {
  if (opts?.throwsOnExit) {
    return {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };
  }

  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("runSetupWizard", () => {
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

  it("defaults to minimal setup and hands optional configuration to the local agent", async () => {
    hasRunnableLocalAgent.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    promptAuthChoiceGrouped.mockResolvedValueOnce("openai-api-key");
    applyAuthChoice.mockResolvedValueOnce({
      config: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
          },
        },
      },
    });
    configureGatewayForSetup.mockClear();
    setupChannels.mockClear();
    setupSkills.mockClear();
    setupInternalHooks.mockClear();
    finalizeSetupWizard.mockClear();
    finishAgentAssistedSetup.mockClear();
    promptDefaultModel.mockClear();
    listSetupMigrationOptions.mockResolvedValueOnce([
      {
        providerId: "codex",
        label: "Codex",
        hint: "/tmp/codex-home",
      },
      {
        providerId: "claude",
        label: "Claude",
        hint: "Import Claude setup",
      },
    ]);

    const select = vi.fn(async ({ message }: WizardSelectParams<unknown>) =>
      message === "How do you want to set up this agent?"
        ? "__setup_model_separately__"
        : "quickstart",
    ) as unknown as WizardPrompter["select"];
    const prompter = buildWizardPrompter({ select });
    const runtime = createRuntime();

    await runSetupWizard({ acceptRisk: true }, runtime, prompter);

    expect(select).toHaveBeenCalledWith({
      message: "How do you want to set up this agent?",
      options: [
        {
          value: "codex",
          label: "Import from Codex",
          hint: "/tmp/codex-home",
        },
        {
          value: "claude",
          label: "Import from Claude",
          hint: "Import Claude setup",
        },
        {
          value: "__setup_model_separately__",
          label: "Set up a model separately",
          hint: "Configure model authentication without importing another agent",
        },
      ],
      initialValue: "__setup_model_separately__",
    });
    expect(promptAuthChoiceGrouped).toHaveBeenCalledWith(
      expect.objectContaining({ includeSkip: false }),
    );
    expect(promptDefaultModel).not.toHaveBeenCalled();
    expect(configureGatewayForSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: "quickstart",
        localPort: 18789,
      }),
    );
    expect(setupChannels).not.toHaveBeenCalled();
    expect(setupSkills).not.toHaveBeenCalled();
    expect(setupInternalHooks).not.toHaveBeenCalled();
    expect(finalizeSetupWizard).not.toHaveBeenCalled();
    expect(finishAgentAssistedSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        opts: { acceptRisk: true },
        settings: expect.objectContaining({
          port: 18789,
          authMode: "token",
        }),
      }),
    );
    vi.clearAllMocks();
  });

  it("emits JSON instead of handing off to the local agent when requested", async () => {
    hasRunnableLocalAgent.mockResolvedValueOnce(true);
    finishAgentAssistedSetup.mockClear();
    const runtime = createRuntime();

    await runSetupWizard(
      { acceptRisk: true, json: true, skipUi: true },
      runtime,
      buildWizardPrompter({}),
    );

    expect(finishAgentAssistedSetup).not.toHaveBeenCalled();
    const output = vi.mocked(runtime.log).mock.lastCall?.[0];
    expect(JSON.parse(String(output))).toEqual({
      ok: true,
      mode: "local",
      workspace: "/tmp/openclaw-workspace",
      gateway: {
        port: 18789,
        bind: "loopback",
        authMode: "token",
        tailscaleMode: "off",
      },
      installDaemon: false,
      skipSkills: false,
      skipHealth: false,
    });
    vi.clearAllMocks();
  });

  it("promotes implicit explicit Gateway intent to the advanced flow", async () => {
    configureGatewayForSetup.mockClear();

    await runSetupWizard(
      {
        acceptRisk: true,
        gatewayPort: 19001,
        skipChannels: true,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
      },
      createRuntime(),
      buildWizardPrompter({}),
    );

    expect(configureGatewayForSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: "advanced",
      }),
    );
    vi.clearAllMocks();
  });

  it("uses the environment-aware Gateway bind default for fresh assisted setup", async () => {
    defaultGatewayBindMode.mockReturnValueOnce("auto");
    hasRunnableLocalAgent.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    promptAuthChoiceGrouped.mockResolvedValueOnce("openai-api-key");
    applyAuthChoice.mockResolvedValueOnce({
      config: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
          },
        },
      },
    });
    configureGatewayForSetup.mockClear();

    const select = vi.fn(async ({ message }: WizardSelectParams<unknown>) =>
      message === "How do you want to set up this agent?"
        ? "__setup_model_separately__"
        : "quickstart",
    ) as unknown as WizardPrompter["select"];

    await runSetupWizard({ acceptRisk: true }, createRuntime(), buildWizardPrompter({ select }));

    expect(defaultGatewayBindMode).toHaveBeenCalledWith("off");
    expect(configureGatewayForSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        quickstartGateway: expect.objectContaining({
          bind: "auto",
        }),
      }),
    );
    vi.clearAllMocks();
  });

  it("keeps implicit no-auth Gateway setups on loopback in containers", async () => {
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/.openclaw/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config: {
        gateway: {
          auth: {
            mode: "none",
          },
        },
      },
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
    defaultGatewayBindMode.mockReturnValueOnce("auto");
    hasRunnableLocalAgent.mockResolvedValueOnce(true);
    configureGatewayForSetup.mockClear();

    await runSetupWizard({ acceptRisk: true }, createRuntime(), buildWizardPrompter({}));

    expect(configureGatewayForSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        quickstartGateway: expect.objectContaining({
          authMode: "none",
          bind: "loopback",
        }),
      }),
    );
    vi.clearAllMocks();
  });

  it("treats auth-only Gateway policy as existing", async () => {
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/.openclaw/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config: {
        gateway: {
          auth: {
            allowTailscale: false,
          },
        },
      },
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
    hasRunnableLocalAgent.mockResolvedValueOnce(true);
    configureGatewayForSetup.mockClear();

    await runSetupWizard({ acceptRisk: true }, createRuntime(), buildWizardPrompter({}));

    expect(configureGatewayForSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        quickstartGateway: expect.objectContaining({
          hasExisting: true,
          authMode: "token",
        }),
      }),
    );
    vi.clearAllMocks();
  });

  it("keeps trusted-proxy auth without a password fallback out of assisted setup", async () => {
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/.openclaw/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config: {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: { userHeader: "x-forwarded-user" },
          },
        },
      },
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
    configureGatewayForSetup.mockClear();
    finishAgentAssistedSetup.mockClear();

    await runSetupWizard(
      {
        acceptRisk: true,
        skipChannels: true,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
      },
      createRuntime(),
      buildWizardPrompter({}),
    );

    expect(configureGatewayForSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        quickstartGateway: expect.objectContaining({
          authMode: "trusted-proxy",
        }),
      }),
    );
    expect(finishAgentAssistedSetup).not.toHaveBeenCalled();
    vi.clearAllMocks();
  });

  it("keeps auth policies that cannot be safely probed out of assisted setup", async () => {
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/.openclaw/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config: {
        gateway: {
          auth: {
            mode: "token",
            rateLimit: { exemptLoopback: false },
          },
        },
      },
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
    configureGatewayForSetup.mockClear();
    finishAgentAssistedSetup.mockClear();

    await runSetupWizard(
      {
        acceptRisk: true,
        skipChannels: true,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
      },
      createRuntime(),
      buildWizardPrompter({}),
    );

    expect(configureGatewayForSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        quickstartGateway: expect.objectContaining({
          authMode: "token",
        }),
      }),
    );
    expect(finishAgentAssistedSetup).not.toHaveBeenCalled();
    vi.clearAllMocks();
  });

  it("keeps authenticated non-loopback Gateway policies out of assisted setup", async () => {
    resolveControlUiLinks.mockReturnValueOnce({
      httpUrl: "http://192.168.1.10:18789",
      wsUrl: "ws://192.168.1.10:18789",
    });
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/.openclaw/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config: {
        gateway: {
          bind: "lan",
          auth: {
            mode: "token",
          },
        },
      },
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
    configureGatewayForSetup.mockClear();
    finishAgentAssistedSetup.mockClear();

    await runSetupWizard(
      {
        acceptRisk: true,
        skipChannels: true,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
      },
      createRuntime(),
      buildWizardPrompter({}),
    );

    expect(configureGatewayForSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        quickstartGateway: expect.objectContaining({
          bind: "lan",
          authMode: "token",
        }),
      }),
    );
    expect(finishAgentAssistedSetup).not.toHaveBeenCalled();
    vi.clearAllMocks();
  });

  it("allows trusted-proxy assisted setup with an environment password fallback", async () => {
    const previous = process.env.OPENCLAW_GATEWAY_PASSWORD;
    process.env.OPENCLAW_GATEWAY_PASSWORD = "fallback-password"; // pragma: allowlist secret
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/.openclaw/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config: {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: { userHeader: "x-forwarded-user" },
          },
        },
      },
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
    hasRunnableLocalAgent.mockResolvedValueOnce(true);
    configureGatewayForSetup.mockClear();
    finishAgentAssistedSetup.mockClear();

    try {
      await runSetupWizard({ acceptRisk: true }, createRuntime(), buildWizardPrompter({}));
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_GATEWAY_PASSWORD;
      } else {
        process.env.OPENCLAW_GATEWAY_PASSWORD = previous;
      }
    }

    expect(configureGatewayForSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        quickstartGateway: expect.objectContaining({
          authMode: "trusted-proxy",
        }),
      }),
    );
    expect(finishAgentAssistedSetup).toHaveBeenCalledOnce();
    vi.clearAllMocks();
  });

  it("hands off immediately when a selected migration produces a runnable agent", async () => {
    listSetupMigrationOptions.mockResolvedValueOnce([
      {
        providerId: "codex",
        label: "Codex",
        hint: "/tmp/codex-home",
      },
      {
        providerId: "hermes",
        label: "Hermes",
        hint: "Import Hermes setup",
      },
    ]);
    hasRunnableLocalAgent.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    runSetupMigrationImport.mockClear();
    promptAuthChoiceGrouped.mockClear();
    finishAgentAssistedSetup.mockClear();

    const select = vi.fn(async ({ message }: WizardSelectParams<unknown>) =>
      message === "How do you want to set up this agent?" ? "codex" : "quickstart",
    ) as unknown as WizardPrompter["select"];
    const prompter = buildWizardPrompter({ select });
    const runtime = createRuntime();

    await runSetupWizard({ acceptRisk: true }, runtime, prompter);

    expect(runSetupMigrationImport).toHaveBeenCalledWith(
      expect.objectContaining({
        opts: expect.objectContaining({
          acceptRisk: true,
          importFrom: "codex",
          workspace: "/tmp/openclaw-workspace",
        }),
        continueOnboarding: true,
      }),
    );
    expect(promptAuthChoiceGrouped).not.toHaveBeenCalled();
    expect(finishAgentAssistedSetup).toHaveBeenCalledOnce();
    vi.clearAllMocks();
  });

  it("routes explicit migration flags directly into migration import", async () => {
    runSetupMigrationImport.mockClear();
    listSetupMigrationOptions.mockClear();
    finishAgentAssistedSetup.mockClear();

    const prompter = buildWizardPrompter({});
    const runtime = createRuntime();

    await runSetupWizard(
      {
        acceptRisk: true,
        importSource: "/tmp/hermes-home",
        importSecrets: true,
      },
      runtime,
      prompter,
    );

    expect(runSetupMigrationImport).toHaveBeenCalledWith(
      expect.objectContaining({
        opts: expect.objectContaining({
          importSource: "/tmp/hermes-home",
          importSecrets: true,
        }),
      }),
    );
    expect(listSetupMigrationOptions).not.toHaveBeenCalled();
    expect(finishAgentAssistedSetup).not.toHaveBeenCalled();
    vi.clearAllMocks();
  });

  it("continues to standalone model setup when a selected migration is not runnable", async () => {
    listSetupMigrationOptions.mockResolvedValueOnce([
      {
        providerId: "claude",
        label: "Claude",
        hint: "/tmp/claude-home",
      },
    ]);
    hasRunnableLocalAgent
      .mockResolvedValue(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    promptAuthChoiceGrouped.mockResolvedValueOnce("openai-api-key");
    runSetupMigrationImport.mockClear();
    promptAuthChoiceGrouped.mockClear();
    finishAgentAssistedSetup.mockClear();

    const select = vi.fn(async ({ message }: WizardSelectParams<unknown>) =>
      message === "How do you want to set up this agent?" ? "claude" : "quickstart",
    ) as unknown as WizardPrompter["select"];
    const prompter = buildWizardPrompter({ select });
    const runtime = createRuntime();

    await runSetupWizard({ acceptRisk: true }, runtime, prompter);

    expect(runSetupMigrationImport).toHaveBeenCalledWith(
      expect.objectContaining({
        opts: expect.objectContaining({
          importFrom: "claude",
        }),
        continueOnboarding: true,
      }),
    );
    expect(promptAuthChoiceGrouped).toHaveBeenCalledWith(
      expect.objectContaining({ includeSkip: false }),
    );
    expect(finishAgentAssistedSetup).toHaveBeenCalledOnce();
    vi.clearAllMocks();
  });

  it("skips migration choices when the target already contains OpenClaw state", async () => {
    hasRunnableLocalAgent.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    isSetupMigrationTargetFresh.mockResolvedValueOnce(false);
    promptAuthChoiceGrouped.mockResolvedValueOnce("openai-api-key");
    listSetupMigrationOptions.mockClear();
    promptAuthChoiceGrouped.mockClear();

    const prompter = buildWizardPrompter({});
    const runtime = createRuntime();

    await runSetupWizard({ acceptRisk: true }, runtime, prompter);

    expect(listSetupMigrationOptions).not.toHaveBeenCalled();
    expect(prompter.select).not.toHaveBeenCalled();
    expect(promptAuthChoiceGrouped).toHaveBeenCalledWith(
      expect.objectContaining({ includeSkip: false }),
    );
    vi.clearAllMocks();
  });

  it("prompts for a replacement model when preserved defaults remain unrunnable", async () => {
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/.openclaw/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
          },
          list: [
            {
              id: "main",
              model: "anthropic/claude-sonnet-4-6",
            },
          ],
        },
      },
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
    hasRunnableLocalAgent
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    promptAuthChoiceGrouped.mockResolvedValueOnce("openai-api-key");
    promptDefaultModel.mockResolvedValueOnce({ model: "anthropic/claude-sonnet-4-6" });
    applyAuthChoice.mockClear();
    promptDefaultModel.mockClear();
    finishAgentAssistedSetup.mockClear();

    const prompter = buildWizardPrompter({});
    const runtime = createRuntime();

    try {
      await runSetupWizard({ acceptRisk: true }, runtime, prompter);

      expect(promptAuthChoiceGrouped).toHaveBeenCalledOnce();
      expect(applyAuthChoice).toHaveBeenCalledOnce();
      expect(promptDefaultModel).toHaveBeenCalledWith(
        expect.objectContaining({
          allowKeep: false,
        }),
      );
      expect(finishAgentAssistedSetup).toHaveBeenCalledOnce();
    } finally {
      hasRunnableLocalAgent.mockReset();
      hasRunnableLocalAgent.mockResolvedValue(false);
      promptDefaultModel.mockReset();
      promptDefaultModel.mockResolvedValue({});
      vi.clearAllMocks();
    }
  });

  it("recovers the selected secondary agent without moving setup to the default agent", async () => {
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/.openclaw/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config: {
        agents: {
          defaults: {
            workspace: "/tmp/main-workspace",
          },
          list: [
            { id: "main", default: true },
            {
              id: "ops",
              workspace: "/tmp/ops-workspace",
              model: {
                primary: "anthropic/old-model",
                fallbacks: ["openai/ops-fallback"],
              },
            },
          ],
        },
      },
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
    hasRunnableLocalAgent.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    promptAuthChoiceGrouped.mockResolvedValueOnce("anthropic-api-key");
    applyAuthChoice.mockResolvedValueOnce({
      config: {
        agents: {
          defaults: {
            workspace: "/tmp/main-workspace",
          },
          list: [
            { id: "main", default: true },
            {
              id: "ops",
              workspace: "/tmp/ops-workspace",
              model: {
                primary: "anthropic/old-model",
                fallbacks: ["openai/ops-fallback"],
              },
            },
          ],
        },
      },
      agentModelOverride: "anthropic/ops-model",
    });
    listSetupMigrationOptions.mockClear();
    finishAgentAssistedSetup.mockClear();

    await runSetupWizard(
      { acceptRisk: true, agentId: "ops" },
      createRuntime(),
      buildWizardPrompter({}),
    );

    expect(hasRunnableLocalAgent).toHaveBeenCalledWith(expect.any(Object), { agentId: "ops" });
    expect(getMockCallArg(hasRunnableLocalAgent, 1, 0, "selected agent readiness")).toEqual(
      expect.objectContaining({
        agents: expect.objectContaining({
          list: expect.arrayContaining([
            expect.objectContaining({
              id: "ops",
              model: {
                primary: "anthropic/ops-model",
                fallbacks: ["openai/ops-fallback"],
              },
            }),
          ]),
        }),
      }),
    );
    expect(listSetupMigrationOptions).not.toHaveBeenCalled();
    expect(applyAuthChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "ops",
        setDefaultModel: false,
      }),
    );
    expect(finishAgentAssistedSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        opts: { acceptRisk: true, agentId: "ops" },
      }),
    );
    expect(ensureWorkspaceAndSessions).toHaveBeenCalledWith(
      "/tmp/ops-workspace",
      expect.any(Object),
      expect.objectContaining({ agentId: "ops" }),
    );
    vi.clearAllMocks();
  });

  it("recovers the configured default agent when no agent is explicitly selected", async () => {
    const defaultAgentConfig = {
      agents: {
        defaults: {
          model: "openai/main-model",
          workspace: "/tmp/main-workspace",
        },
        list: [
          { id: "main" },
          {
            id: "ops",
            default: true,
            workspace: "/tmp/ops-workspace",
            model: {
              primary: "anthropic/old-model",
              fallbacks: ["openai/ops-fallback"],
            },
          },
        ],
      },
    };
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/.openclaw/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config: defaultAgentConfig,
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
    hasRunnableLocalAgent.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    promptAuthChoiceGrouped.mockResolvedValueOnce("anthropic-api-key");
    applyAuthChoice.mockResolvedValueOnce({
      config: defaultAgentConfig,
      agentModelOverride: "anthropic/ops-model",
    });
    finishAgentAssistedSetup.mockClear();

    await runSetupWizard({ acceptRisk: true }, createRuntime(), buildWizardPrompter({}));

    expect(hasRunnableLocalAgent).toHaveBeenCalledWith(expect.any(Object), { agentId: "ops" });
    expect(getMockCallArg(hasRunnableLocalAgent, 1, 0, "default agent readiness")).toEqual(
      expect.objectContaining({
        agents: expect.objectContaining({
          defaults: expect.objectContaining({ model: "openai/main-model" }),
          list: expect.arrayContaining([
            expect.objectContaining({
              id: "ops",
              model: {
                primary: "anthropic/ops-model",
                fallbacks: ["openai/ops-fallback"],
              },
            }),
          ]),
        }),
      }),
    );
    expect(applyAuthChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "ops",
        setDefaultModel: false,
      }),
    );
    expect(ensureWorkspaceAndSessions).toHaveBeenCalledWith(
      "/tmp/ops-workspace",
      expect.any(Object),
      expect.objectContaining({ agentId: "ops" }),
    );
    expect(finishAgentAssistedSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        opts: { acceptRisk: true, agentId: "ops" },
      }),
    );
    vi.clearAllMocks();
  });

  it("does not pin an inherited workspace when recovering the configured default agent", async () => {
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/.openclaw/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            workspace: "/tmp/main-workspace",
          },
          list: [{ id: "ops", default: true }],
        },
      },
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
    hasRunnableLocalAgent.mockResolvedValueOnce(true);

    await runSetupWizard({ acceptRisk: true }, createRuntime(), buildWizardPrompter({}));

    const readinessConfig = getMockCallArg(hasRunnableLocalAgent, 0, 0, "default agent readiness");
    const agents = requireRecord(
      requireRecord(readinessConfig, "default agent readiness").agents,
      "default agent readiness agents",
    );
    const list = agents.list as Array<Record<string, unknown>>;
    expect(requireRecord(agents.defaults, "default agent readiness defaults").workspace).toBe(
      "/tmp/main-workspace",
    );
    expect(list.find((entry) => entry.id === "ops")).not.toHaveProperty("workspace");
    vi.clearAllMocks();
  });

  it("applies a custom provider model only to the selected secondary agent", async () => {
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/.openclaw/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config: {
        agents: {
          defaults: {
            model: "openai/main-model",
            workspace: "/tmp/main-workspace",
          },
          list: [
            { id: "main", default: true },
            {
              id: "ops",
              workspace: "/tmp/ops-workspace",
              model: {
                primary: "anthropic/old-model",
                fallbacks: ["openai/ops-fallback"],
              },
            },
          ],
        },
      },
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
    hasRunnableLocalAgent.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    promptAuthChoiceGrouped.mockResolvedValueOnce("custom-api-key");
    promptCustomApiConfig.mockResolvedValueOnce({
      config: {
        agents: {
          defaults: {
            model: "custom/new-model",
            workspace: "/tmp/main-workspace",
          },
          list: [
            { id: "main", default: true },
            { id: "ops", workspace: "/tmp/ops-workspace", model: "anthropic/old-model" },
          ],
        },
      },
      providerId: "custom",
      modelId: "new-model",
    });

    await runSetupWizard(
      { acceptRisk: true, agentId: "ops" },
      createRuntime(),
      buildWizardPrompter({}),
    );

    const readinessConfig = getMockCallArg(hasRunnableLocalAgent, 1, 0, "selected agent readiness");
    expect(readinessConfig).toEqual(
      expect.objectContaining({
        agents: expect.objectContaining({
          defaults: expect.objectContaining({ model: "openai/main-model" }),
          list: expect.arrayContaining([
            expect.objectContaining({
              id: "ops",
              model: {
                primary: "custom/new-model",
                fallbacks: ["openai/ops-fallback"],
              },
            }),
          ]),
        }),
      }),
    );
    vi.clearAllMocks();
  });

  it("scopes post-auth model selection to the selected secondary agent", async () => {
    const selectedConfig = {
      agents: {
        defaults: {
          model: "openai/main-model",
          workspace: "/tmp/main-workspace",
        },
        list: [
          { id: "main", default: true },
          { id: "ops", workspace: "/tmp/ops-workspace", model: "anthropic/ops-model" },
        ],
      },
    };
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/.openclaw/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config: selectedConfig,
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
    hasRunnableLocalAgent.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    promptAuthChoiceGrouped.mockResolvedValueOnce("demo-provider");
    applyAuthChoice.mockResolvedValueOnce({ config: selectedConfig });
    resolveProviderPluginChoice.mockReturnValueOnce({
      provider: providerPluginStub({
        id: "demo-provider",
        wizard: {
          setup: {
            modelSelection: {
              promptWhenAuthChoiceProvided: true,
            },
          },
        },
      }),
      method: undefined as never,
      wizard: {
        modelSelection: {
          promptWhenAuthChoiceProvided: true,
        },
      },
    });
    applyPrimaryModel.mockImplementationOnce((config, model) => ({
      ...config,
      agents: {
        ...config.agents,
        defaults: {
          ...config.agents?.defaults,
          model,
        },
      },
    }));
    promptDefaultModel.mockResolvedValueOnce({ model: "demo-provider/new-model" });

    await runSetupWizard(
      { acceptRisk: true, agentId: "ops" },
      createRuntime(),
      buildWizardPrompter({}),
    );

    const pickerOptions = requireRecord(
      getMockCallArg(promptDefaultModel, 0, 0, "selected agent model picker"),
      "selected agent model picker",
    );
    expect(pickerOptions.agentDir).toContain("/agents/ops/agent");
    expect(pickerOptions.config).toEqual(
      expect.objectContaining({
        agents: expect.objectContaining({
          defaults: expect.objectContaining({ model: "anthropic/ops-model" }),
        }),
      }),
    );
    vi.clearAllMocks();
  });

  it("does not hand off when an explicit auth choice leaves the default agent unrunnable", async () => {
    hasRunnableLocalAgent.mockResolvedValueOnce(false);
    applyAuthChoice.mockClear();
    finishAgentAssistedSetup.mockClear();

    const prompter = buildWizardPrompter({});
    const runtime = createRuntime();

    await expect(
      runSetupWizard({ acceptRisk: true, authChoice: "openai-api-key" }, runtime, prompter),
    ).rejects.toThrow("The selected model authentication did not make the default agent runnable.");

    expect(applyAuthChoice).toHaveBeenCalledOnce();
    expect(finishAgentAssistedSetup).not.toHaveBeenCalled();
    vi.clearAllMocks();
  });

  it("does not hand off when an explicit auth choice requests retry and remains unrunnable", async () => {
    hasRunnableLocalAgent.mockResolvedValueOnce(false);
    applyAuthChoice.mockResolvedValueOnce({
      config: {},
      retrySelection: true,
    });
    finishAgentAssistedSetup.mockClear();

    const prompter = buildWizardPrompter({});
    const runtime = createRuntime();

    await expect(
      runSetupWizard({ acceptRisk: true, authChoice: "openai-api-key" }, runtime, prompter),
    ).rejects.toThrow("The selected model authentication did not make the default agent runnable.");

    expect(applyAuthChoice).toHaveBeenCalledOnce();
    expect(finishAgentAssistedSetup).not.toHaveBeenCalled();
    vi.clearAllMocks();
  });

  it("applies an explicit node manager without entering the infrastructure wizard", async () => {
    hasRunnableLocalAgent.mockResolvedValueOnce(true);
    replaceConfigFile.mockClear();
    configureGatewayForSetup.mockClear();
    setupSkills.mockClear();

    const prompter = buildWizardPrompter({});
    const runtime = createRuntime();

    await runSetupWizard(
      { acceptRisk: true, nodeManager: "pnpm", skipUi: true },
      runtime,
      prompter,
    );

    expect(replaceConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        nextConfig: expect.objectContaining({
          skills: {
            install: {
              nodeManager: "pnpm",
            },
          },
        }),
      }),
    );
    expect(configureGatewayForSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: "quickstart",
      }),
    );
    expect(setupSkills).not.toHaveBeenCalled();
    vi.clearAllMocks();
  });

  it("skips auth prompts when the existing local agent is runnable", async () => {
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/.openclaw/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
          },
        },
      },
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
    hasRunnableLocalAgent.mockResolvedValueOnce(true);
    promptAuthChoiceGrouped.mockClear();
    finishAgentAssistedSetup.mockClear();

    const prompter = buildWizardPrompter({});
    const runtime = createRuntime();

    await runSetupWizard({ acceptRisk: true }, runtime, prompter);

    expect(prompter.select).not.toHaveBeenCalled();
    expect(promptAuthChoiceGrouped).not.toHaveBeenCalled();
    expect(finishAgentAssistedSetup).toHaveBeenCalledOnce();
    vi.clearAllMocks();
  });

  it("keeps existing remote Gateway configs out of local agent-assisted setup", async () => {
    const remoteConfig = {
      gateway: {
        mode: "remote" as const,
        remote: {
          url: "wss://remote.example.com:18789",
        },
      },
    };
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/.openclaw/openclaw.json",
      exists: true,
      raw: JSON.stringify(remoteConfig),
      parsed: remoteConfig,
      resolved: remoteConfig,
      valid: true,
      config: remoteConfig,
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
    promptRemoteGatewayConfig.mockClear();
    configureGatewayForSetup.mockClear();
    finishAgentAssistedSetup.mockClear();

    const select = vi.fn(async ({ message }: WizardSelectParams<unknown>) =>
      message === "Config handling" ? "keep" : "quickstart",
    ) as unknown as WizardPrompter["select"];
    const prompter = buildWizardPrompter({ select });
    const runtime = createRuntime();

    await runSetupWizard({ acceptRisk: true }, runtime, prompter);

    expect(promptRemoteGatewayConfig).toHaveBeenCalledWith(remoteConfig, prompter, {
      secretInputMode: undefined,
    });
    expect(configureGatewayForSetup).not.toHaveBeenCalled();
    expect(finishAgentAssistedSetup).not.toHaveBeenCalled();
    vi.clearAllMocks();
  });

  it("skips provider entries without an id during preferred-provider lookup", async () => {
    setupChannels.mockClear();
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/.openclaw/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config: {},
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
    resolvePreferredProviderForAuthChoice.mockResolvedValueOnce("demo-provider");
    resolvePluginProvidersRuntime.mockReturnValueOnce([
      providerPluginStub({ id: "" }),
      providerPluginStub({ id: "demo-provider", wizard: { setup: {} } }),
    ]);

    const caseDir = await makeCaseDir("provider-missing-id-");
    const select = vi.fn(async ({ message }: WizardSelectParams<unknown>) => {
      if (message === "Setup mode") {
        return "quickstart";
      }
      if (message === "Select channel (QuickStart)") {
        return "__skip__";
      }
      if (message === "How do you want to hatch your agent?") {
        return "skip";
      }
      return "skip";
    }) as unknown as WizardPrompter["select"];
    const confirm = vi.fn(async () => true) as unknown as WizardPrompter["confirm"];
    const prompter = buildWizardPrompter({ select, confirm });
    const runtime = createRuntime({ throwsOnExit: true });

    await expect(
      runSetupWizard(
        {
          acceptRisk: true,
          flow: "quickstart",
          authChoice: "ollama",
          installDaemon: false,
          skipProviders: false,
          skipSkills: true,
          skipSearch: true,
          skipChannels: false,
          skipUi: true,
          workspace: caseDir,
        },
        runtime,
        prompter,
      ),
    ).resolves.toBeUndefined();
    expectRecordFields(
      getMockCallArg(resolvePreferredProviderForAuthChoice, 0, 0, "preferred provider lookup"),
      { choice: "ollama" },
      "preferred provider lookup params",
    );
    expect(resolvePluginProvidersRuntime).toHaveBeenCalled();
    setupChannels.mockClear();
  });

  it("exits when config is invalid", async () => {
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/.openclaw/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: false,
      config: {},
      issues: [{ path: "routing.allowFrom", message: "Legacy key" }],
      warnings: [],
      legacyIssues: [{ path: "routing.allowFrom", message: "Legacy key" }],
    });

    const select = vi.fn(
      async (_params: WizardSelectParams<unknown>) => "quickstart",
    ) as unknown as WizardPrompter["select"];
    const prompter = buildWizardPrompter({ select });
    const runtime = createRuntime({ throwsOnExit: true });

    await expect(
      runSetupWizard(
        {
          acceptRisk: true,
          flow: "quickstart",
          authChoice: "skip",
          installDaemon: false,
          skipProviders: true,
          skipSkills: true,
          skipSearch: true,
          skipHealth: true,
          skipUi: true,
        },
        runtime,
        prompter,
      ),
    ).rejects.toThrow("exit:1");

    expect(select).not.toHaveBeenCalled();
    expect(prompter.outro).toHaveBeenCalled();
  });

  it("skips prompts and setup steps when flags are set", async () => {
    const select = vi.fn(
      async (_params: WizardSelectParams<unknown>) => "quickstart",
    ) as unknown as WizardPrompter["select"];
    const multiselect: WizardPrompter["multiselect"] = vi.fn(async () => []);
    const prompter = buildWizardPrompter({ select, multiselect });
    const runtime = createRuntime({ throwsOnExit: true });
    createConfigIO.mockClear();
    ensureAuthProfileStore.mockClear();

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "skip",
        installDaemon: false,
        skipProviders: true,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
      },
      runtime,
      prompter,
    );

    expect(createConfigIO).toHaveBeenCalledWith({ pluginValidation: "skip" });
    expect(select).not.toHaveBeenCalled();
    expect(ensureAuthProfileStore).not.toHaveBeenCalled();
    expect(setupChannels).not.toHaveBeenCalled();
    expect(setupSkills).not.toHaveBeenCalled();
    expect(healthCommand).not.toHaveBeenCalled();
    expect(runTui).not.toHaveBeenCalled();
  });
  it("persists skipBootstrap and skips workspace bootstrap creation when requested", async () => {
    ensureWorkspaceAndSessions.mockClear();
    replaceConfigFile.mockClear();

    const workspaceDir = await makeCaseDir("skip-bootstrap-");
    const prompter = buildWizardPrompter({});
    const runtime = createRuntime();

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "skip",
        installDaemon: false,
        skipBootstrap: true,
        skipChannels: true,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
        workspace: workspaceDir,
      },
      runtime,
      prompter,
    );

    const replaceParams = requireRecord(
      getMockCallArg(replaceConfigFile, 0, 0, "config replacement"),
      "config replacement params",
    );
    const nextConfig = requireRecord(replaceParams.nextConfig, "next config");
    const agents = requireRecord(nextConfig.agents, "next config agents");
    expectRecordFields(
      requireRecord(agents.defaults, "next config agent defaults"),
      {
        skipBootstrap: true,
        workspace: workspaceDir,
      },
      "next config agent defaults",
    );
    expectRecordFields(
      replaceParams.writeOptions,
      { allowConfigSizeDrop: false },
      "config replacement write options",
    );
    expect(getMockCallArg(ensureWorkspaceAndSessions, 0, 0, "workspace setup")).toBe(workspaceDir);
    expect(getMockCallArg(ensureWorkspaceAndSessions, 0, 1, "workspace setup")).toBe(runtime);
    expectRecordFields(
      getMockCallArg(ensureWorkspaceAndSessions, 0, 2, "workspace setup"),
      { skipBootstrap: true },
      "workspace setup options",
    );
  });

  it("allows size-drop writes for pending plugin install record migration", async () => {
    replaceConfigFile.mockClear();
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/.openclaw/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config: {
        plugins: {
          installs: {
            demo: { source: "npm", spec: "@openclaw/demo-plugin" },
          },
        },
      },
      issues: [],
      warnings: [],
      legacyIssues: [],
    });

    const workspaceDir = await makeCaseDir("plugin-install-migration-");
    const select = vi.fn(async ({ options }: WizardSelectParams<unknown>) => {
      const values = options.map((option) => option.value);
      if (values.includes("keep")) {
        return "keep";
      }
      if (values.includes("quickstart")) {
        return "quickstart";
      }
      if (values.includes("__skip__")) {
        return "__skip__";
      }
      return values[0];
    }) as unknown as WizardPrompter["select"];
    const prompter = buildWizardPrompter({ select });
    const runtime = createRuntime();

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "skip",
        installDaemon: false,
        skipBootstrap: true,
        skipChannels: true,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
        workspace: workspaceDir,
      },
      runtime,
      prompter,
    );

    expect(replaceConfigFile).toHaveBeenCalledTimes(3);
    const migrationParams = requireRecord(
      getMockCallArg(replaceConfigFile, 0, 0, "migration config replacement"),
      "migration config replacement params",
    );
    expect(
      requireRecord(migrationParams.nextConfig, "migration next config").plugins,
    ).toBeUndefined();
    const migrationWriteOptions = expectRecordFields(
      migrationParams.writeOptions,
      { allowConfigSizeDrop: true },
      "migration config replacement write options",
    );
    expect(migrationWriteOptions.unsetPaths).toContainEqual(["plugins", "installs"]);

    const replaceParams = requireRecord(
      getMockCallArg(replaceConfigFile, 2, 0, "config replacement"),
      "config replacement params",
    );
    expect(requireRecord(replaceParams.nextConfig, "next config").plugins).toBeUndefined();
    expectRecordFields(
      replaceParams.writeOptions,
      { allowConfigSizeDrop: false },
      "config replacement write options",
    );
  });

  it("fails fast if the auth choice prompt returns nothing", async () => {
    promptAuthChoiceGrouped.mockImplementationOnce(async () => undefined as never);
    const prompter = buildWizardPrompter();
    const runtime = createRuntime();

    await expect(
      runSetupWizard(
        {
          acceptRisk: true,
          flow: "quickstart",
          installDaemon: false,
          skipProviders: true,
          skipSkills: true,
          skipSearch: true,
          skipHealth: true,
          skipUi: true,
        },
        runtime,
        prompter,
      ),
    ).rejects.toThrow("auth choice is required");
  });

  async function runTuiHatchTestAndExpectLaunch(params: {
    writeBootstrapFile: boolean;
    expectedMessage: string | undefined;
  }) {
    runTui.mockClear();

    const workspaceDir = await makeCaseDir("workspace-");
    if (params.writeBootstrapFile) {
      await fs.writeFile(path.join(workspaceDir, DEFAULT_BOOTSTRAP_FILENAME), "{}");
    }

    const select = vi.fn(async (opts: WizardSelectParams<unknown>) => {
      if (opts.message === "How do you want to hatch your agent?") {
        return "tui";
      }
      return "quickstart";
    }) as unknown as WizardPrompter["select"];

    const prompter = buildWizardPrompter({ select });
    const runtime = createRuntime({ throwsOnExit: true });

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        mode: "local",
        workspace: workspaceDir,
        authChoice: "skip",
        skipProviders: true,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        installDaemon: false,
      },
      runtime,
      prompter,
    );

    expectRecordFields(
      getMockCallArg(runTui, 0, 0, "tui launch"),
      {
        local: true,
        deliver: false,
        message: params.expectedMessage,
      },
      "tui launch options",
    );
  }

  it("launches TUI without auto-delivery when hatching", async () => {
    await runTuiHatchTestAndExpectLaunch({
      writeBootstrapFile: true,
      expectedMessage: "Wake up, my friend!",
    });
  });

  it("offers TUI hatch even without BOOTSTRAP.md", async () => {
    await runTuiHatchTestAndExpectLaunch({
      writeBootstrapFile: false,
      expectedMessage: undefined,
    });
  });

  it("shows the web search hint at the end of setup", async () => {
    const prevBraveKey = process.env.BRAVE_API_KEY;
    delete process.env.BRAVE_API_KEY;

    try {
      const note: WizardPrompter["note"] = vi.fn(async () => {});
      const prompter = buildWizardPrompter({ note });
      const runtime = createRuntime();

      await runSetupWizard(
        {
          acceptRisk: true,
          flow: "quickstart",
          authChoice: "skip",
          installDaemon: false,
          skipProviders: true,
          skipSkills: true,
          skipSearch: true,
          skipHealth: true,
          skipUi: true,
        },
        runtime,
        prompter,
      );

      const calls = getWizardNoteCalls(note);
      expect(calls.length).toBeGreaterThan(0);
      const noteTitles = calls.map((call) => call?.[1]);
      expect(noteTitles).toContain("Web search");
    } finally {
      if (prevBraveKey === undefined) {
        delete process.env.BRAVE_API_KEY;
      } else {
        process.env.BRAVE_API_KEY = prevBraveKey;
      }
    }
  });

  it("defers channel setup plugin loads during QuickStart until a channel is selected", async () => {
    const prompter = buildWizardPrompter({});
    const runtime = createRuntime();

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "skip",
        installDaemon: false,
        skipProviders: true,
        skipChannels: false,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
      },
      runtime,
      prompter,
    );

    expectMockCallArgNotNull(setupChannels, 0, 0, "channel setup");
    expectMockCallArgNotNull(setupChannels, 0, 1, "channel setup");
    expectMockCallArgNotNull(setupChannels, 0, 2, "channel setup");
    expectRecordFields(
      getMockCallArg(setupChannels, 0, 3, "channel setup"),
      {
        deferStatusUntilSelection: true,
        quickstartDefaults: true,
      },
      "channel setup options",
    );
  });

  it("prompts for a model during explicit interactive Ollama setup", async () => {
    promptDefaultModel.mockClear();
    warnIfModelConfigLooksOff.mockClear();
    resolveProviderPluginChoice.mockReturnValue({
      provider: {
        id: "ollama",
        label: "Ollama",
        auth: [],
        wizard: {
          setup: {
            modelSelection: {
              promptWhenAuthChoiceProvided: true,
              allowKeepCurrent: false,
            },
          },
        },
      },
      method: {
        id: "local",
        label: "Ollama",
        kind: "custom",
        run: vi.fn(async () => ({ profiles: [] })),
      },
      wizard: {
        modelSelection: {
          promptWhenAuthChoiceProvided: true,
          allowKeepCurrent: false,
        },
      },
    });
    const prompter = buildWizardPrompter({});
    const runtime = createRuntime();

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "ollama",
        installDaemon: false,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
      },
      runtime,
      prompter,
    );

    expectRecordFields(
      getMockCallArg(promptDefaultModel, 0, 0, "default model prompt"),
      {
        allowKeep: false,
        browseCatalogOnDemand: true,
      },
      "default model prompt params",
    );
    expectMockCallArgNotNull(warnIfModelConfigLooksOff, 0, 0, "model warning");
    expectMockCallArgNotNull(warnIfModelConfigLooksOff, 0, 1, "model warning");
    expectRecordFields(
      getMockCallArg(warnIfModelConfigLooksOff, 0, 2, "model warning"),
      { validateCatalog: false },
      "model warning options",
    );
  });

  it("re-prompts for auth when applyAuthChoice requests retry selection", async () => {
    promptAuthChoiceGrouped.mockReset();
    promptAuthChoiceGrouped
      .mockResolvedValueOnce("demo-provider-one")
      .mockResolvedValueOnce("demo-provider-two");
    applyAuthChoice.mockReset();
    applyAuthChoice
      .mockResolvedValueOnce({
        config: {
          plugins: {
            entries: {
              "demo-provider-plugin": {
                enabled: true,
              },
            },
          },
        },
        retrySelection: true,
      })
      .mockResolvedValueOnce({
        config: {
          agents: {
            defaults: {
              model: {
                primary: "demo-provider-two/model",
              },
            },
          },
        },
      });

    const prompter = buildWizardPrompter({});
    const runtime = createRuntime();

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        installDaemon: false,
        skipChannels: true,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
      },
      runtime,
      prompter,
    );

    expect(promptAuthChoiceGrouped).toHaveBeenCalledTimes(2);
    expect(applyAuthChoice).toHaveBeenCalledTimes(2);
    expectRecordFields(
      getMockCallArg(applyAuthChoice, 1, 0, "retry auth choice"),
      {
        authChoice: "demo-provider-two",
        config: {
          plugins: {
            entries: {
              "demo-provider-plugin": {
                enabled: true,
              },
            },
          },
        },
      },
      "retry auth choice params",
    );
  });

  it("forwards provider-specific auth flags to applyAuthChoice opts", async () => {
    applyAuthChoice.mockReset();
    applyAuthChoice.mockResolvedValueOnce({
      config: {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.5",
            },
          },
        },
      },
    });

    const prompter = buildWizardPrompter({});
    const runtime = createRuntime();

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "openai-chatgpt-api-key",
        openaiApiKey: "sk-flag-value",
        installDaemon: false,
        skipChannels: true,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
        skipHooks: true,
      },
      runtime,
      prompter,
    );

    expect(applyAuthChoice).toHaveBeenCalledTimes(1);
    const call = getMockCallArg(applyAuthChoice, 0, 0, "openai auth choice");
    const opts = (call as { opts?: Record<string, unknown> }).opts ?? {};
    expect(opts.openaiApiKey).toBe("sk-flag-value");
  });

  it("passes preserveExistingDefaultModel to applyAuthChoice to protect existing default model", async () => {
    applyAuthChoice.mockReset();
    applyAuthChoice.mockResolvedValueOnce({
      config: {
        agents: {
          defaults: {
            model: {
              primary: "google/gemini-3.1-pro-preview",
            },
          },
        },
      },
    });

    const prompter = buildWizardPrompter({});
    const runtime = createRuntime();

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "google-api-key",
        installDaemon: false,
        skipChannels: true,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
      },
      runtime,
      prompter,
    );

    expect(applyAuthChoice).toHaveBeenCalledTimes(1);
    const call = getMockCallArg(applyAuthChoice, 0, 0, "google auth choice");
    // Preserve the user's existing default model when a new provider is
    // configured through the setup wizard, matching the contract already
    // used in configure.gateway-auth.ts. Without this flag, configuring a
    // paid Google Gemini key would silently overwrite the user's default
    // model, causing existing heartbeat turns to consume paid API quota.
    expect((call as { preserveExistingDefaultModel?: boolean }).preserveExistingDefaultModel).toBe(
      true,
    );
  });

  it("shows plugin compatibility notices for an existing valid config", async () => {
    buildPluginCompatibilitySnapshotNotices.mockReturnValue([
      {
        pluginId: "legacy-plugin",
        code: "legacy-before-agent-start",
        compatCode: "legacy-before-agent-start",
        severity: "warn",
        message:
          "still uses legacy before_agent_start; keep regression coverage on this plugin, and prefer before_model_resolve/before_prompt_build for new work.",
      },
    ]);
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/.openclaw/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config: {
        gateway: {},
      },
      issues: [],
      warnings: [],
      legacyIssues: [],
    });

    const note: WizardPrompter["note"] = vi.fn(async () => {});
    const select = vi.fn(async (opts: WizardSelectParams<unknown>) => {
      if (opts.message === "Config handling") {
        return "keep";
      }
      return "quickstart";
    }) as unknown as WizardPrompter["select"];
    const prompter = buildWizardPrompter({ note, select });
    const runtime = createRuntime();

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        authChoice: "skip",
        installDaemon: false,
        skipProviders: true,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
      },
      runtime,
      prompter,
    );

    const calls = getWizardNoteCalls(note);
    const noteTitles = calls.map((call) => call?.[1]);
    expect(noteTitles).toContain("Plugin compatibility");
    const noteBodies = calls
      .map((call) => call?.[0])
      .filter((body): body is string => typeof body === "string");
    const legacyPluginNotes = noteBodies.filter((body) => body.includes("legacy-plugin"));
    expect(legacyPluginNotes.length).toBeGreaterThan(0);
  });

  it("resolves gateway.auth.password SecretRef for local setup probe", async () => {
    const previous = process.env.OPENCLAW_GATEWAY_PASSWORD;
    process.env.OPENCLAW_GATEWAY_PASSWORD = "gateway-ref-password"; // pragma: allowlist secret
    probeGatewayReachable.mockClear();
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/.openclaw/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config: {
        gateway: {
          auth: {
            mode: "password",
            password: {
              source: "env",
              provider: "default",
              id: "OPENCLAW_GATEWAY_PASSWORD",
            },
          },
        },
      },
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
    const select = vi.fn(async (opts: WizardSelectParams<unknown>) => {
      if (opts.message === "Config handling") {
        return "keep";
      }
      return "quickstart";
    }) as unknown as WizardPrompter["select"];
    const prompter = buildWizardPrompter({ select });
    const runtime = createRuntime();

    try {
      await runSetupWizard(
        {
          acceptRisk: true,
          flow: "quickstart",
          mode: "local",
          authChoice: "skip",
          installDaemon: false,
          skipProviders: true,
          skipSkills: true,
          skipSearch: true,
          skipHealth: true,
          skipUi: true,
        },
        runtime,
        prompter,
      );
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_GATEWAY_PASSWORD;
      } else {
        process.env.OPENCLAW_GATEWAY_PASSWORD = previous;
      }
    }

    expectRecordFields(
      getMockCallArg(probeGatewayReachable, 0, 0, "gateway probe"),
      {
        url: "ws://127.0.0.1:18789",
        password: "gateway-ref-password", // pragma: allowlist secret
      },
      "gateway probe params",
    );
  });

  it("passes secretInputMode through to local gateway config step", async () => {
    configureGatewayForSetup.mockClear();
    const prompter = buildWizardPrompter({});
    const runtime = createRuntime();

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        mode: "local",
        authChoice: "skip",
        installDaemon: false,
        skipProviders: true,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
        secretInputMode: "ref", // pragma: allowlist secret
      },
      runtime,
      prompter,
    );

    expectRecordFields(
      getMockCallArg(configureGatewayForSetup, 0, 0, "gateway setup"),
      {
        secretInputMode: "ref", // pragma: allowlist secret
      },
      "gateway setup params",
    );
  });

  it("shows the resolved gateway port in quickstart for fresh envs", async () => {
    const previousPort = process.env.OPENCLAW_GATEWAY_PORT;
    process.env.OPENCLAW_GATEWAY_PORT = "18791";
    const note: WizardPrompter["note"] = vi.fn(async () => {});
    const prompter = buildWizardPrompter({ note });
    const runtime = createRuntime();

    try {
      await runSetupWizard(
        {
          acceptRisk: true,
          flow: "quickstart",
          authChoice: "skip",
          installDaemon: false,
          skipProviders: true,
          skipSkills: true,
          skipSearch: true,
          skipHealth: true,
          skipUi: true,
        },
        runtime,
        prompter,
      );
    } finally {
      if (previousPort === undefined) {
        delete process.env.OPENCLAW_GATEWAY_PORT;
      } else {
        process.env.OPENCLAW_GATEWAY_PORT = previousPort;
      }
    }

    const calls = (note as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const matchingQuickStartNotes = calls.filter(
      (call) =>
        call?.[1] === "QuickStart" &&
        typeof call?.[0] === "string" &&
        call[0].includes("Gateway port: 18791"),
    );
    expect(matchingQuickStartNotes.length).toBeGreaterThan(0);
  });

  it("localizes the quickstart summary", async () => {
    const previousPort = process.env.OPENCLAW_GATEWAY_PORT;
    const previousLocale = process.env.OPENCLAW_LOCALE;
    process.env.OPENCLAW_GATEWAY_PORT = "18791";
    process.env.OPENCLAW_LOCALE = "zh-CN";
    const note: WizardPrompter["note"] = vi.fn(async () => {});
    const prompter = buildWizardPrompter({ note });
    const runtime = createRuntime();

    try {
      await runSetupWizard(
        {
          acceptRisk: true,
          flow: "quickstart",
          authChoice: "skip",
          installDaemon: false,
          skipProviders: true,
          skipSkills: true,
          skipSearch: true,
          skipHealth: true,
          skipUi: true,
        },
        runtime,
        prompter,
      );
    } finally {
      if (previousPort === undefined) {
        delete process.env.OPENCLAW_GATEWAY_PORT;
      } else {
        process.env.OPENCLAW_GATEWAY_PORT = previousPort;
      }
      if (previousLocale === undefined) {
        delete process.env.OPENCLAW_LOCALE;
      } else {
        process.env.OPENCLAW_LOCALE = previousLocale;
      }
    }

    const calls = (note as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const matchingQuickStartNotes = calls.filter(
      (call) =>
        call?.[1] === "QuickStart" &&
        typeof call?.[0] === "string" &&
        call[0].includes("Gateway 端口：18791") &&
        call[0].includes("Tailscale 暴露方式：关闭"),
    );
    expect(matchingQuickStartNotes.length).toBeGreaterThan(0);
  });

  it("uses manifest setup metadata for post-auth model policy without loading provider runtime", async () => {
    promptDefaultModel.mockClear();
    resolvePluginProvidersRuntime.mockClear();
    resolveManifestProviderAuthChoice.mockReturnValue({
      pluginId: "openai",
      providerId: "openai",
      methodId: "oauth",
      choiceId: "openai",
      choiceLabel: "ChatGPT/Codex Browser Login",
    });
    resolvePluginSetupProvider.mockReturnValue({
      id: "openai",
      label: "OpenAI Codex",
      auth: [
        {
          id: "oauth",
          label: "ChatGPT/Codex Browser Login",
          kind: "oauth",
          wizard: {
            modelSelection: {
              allowKeepCurrent: false,
            },
          },
          run: vi.fn(async () => ({ profiles: [] })),
        },
      ],
    });
    promptAuthChoiceGrouped.mockResolvedValueOnce("openai");
    const prompter = buildWizardPrompter({});
    const runtime = createRuntime();

    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "quickstart",
        installDaemon: false,
        skipSkills: true,
        skipSearch: true,
        skipHealth: true,
        skipUi: true,
      },
      runtime,
      prompter,
    );

    expectRecordFields(
      getMockCallArg(resolvePluginSetupProvider, 0, 0, "plugin setup provider"),
      {
        provider: "openai",
        pluginIds: ["openai"],
      },
      "plugin setup provider params",
    );
    expect(resolvePluginProvidersRuntime).not.toHaveBeenCalled();
    expectRecordFields(
      getMockCallArg(promptDefaultModel, 0, 0, "default model prompt"),
      { allowKeep: false },
      "default model prompt params",
    );
  });
});
