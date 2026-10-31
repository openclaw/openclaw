import { vi } from "vitest";
import type { ConfigFileSnapshot, ConfigMutationIO, OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { committedConfigFiles } from "./committed-config.test-support.js";
import { createTestConfigSnapshot } from "./test-runtime-config-helpers.js";

const wizardTestMocks = vi.hoisted(() => {
  const writeConfigFile = vi.fn<(config: OpenClawConfig) => Promise<void>>();
  return {
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    isTerminalInteractive: vi.fn(),
    clackIntro: vi.fn(),
    clackOutro: vi.fn(),
    clackSelect: vi.fn(),
    clackText: vi.fn(),
    clackConfirm: vi.fn(),
    clackPassword: vi.fn(),
    resolveSearchProviderOptions: vi.fn(),
    resolvePluginContributionOwners: vi.fn(),
    setupSearch: vi.fn(),
    runMemorySetupFlow: vi.fn<typeof import("../flows/memory-setup.js").runMemorySetupFlow>(),
    setupPluginConfig:
      vi.fn<typeof import("../wizard/setup.plugin-config.js").configurePluginConfig>(),
    setupSkills: vi.fn<typeof import("./onboard-skills.js").setupSkills>(),
    ensureWorkspaceAndSessions: vi.fn(),
    assertConfigPathForWrite: vi.fn(),
    readConfigFileSnapshot: vi.fn(),
    writeConfigFile,
    replaceConfigFile: vi.fn(
      async (params: {
        nextConfig: OpenClawConfig;
        baseHash?: string;
        writeOptions?: { assertConfigPathForWrite?: () => void };
      }) => {
        params.writeOptions?.assertConfigPathForWrite?.();
        await writeConfigFile(params.nextConfig);
        return committedConfigFiles.write(params.nextConfig as OpenClawConfig);
      },
    ),
    resolveGatewayPort: vi.fn(),
    createClackPrompter: vi.fn(),
    note: vi.fn(),
    printWizardHeader: vi.fn(),
    probeGatewayReachable: vi.fn(),
    waitForGatewayReachable: vi.fn(async () => ({ ok: true })),
    resolveAdvertisedControlUiLinks: vi.fn(),
    resolveControlUiLinks: vi.fn(),
    resolveLocalControlUiProbeLinks: vi.fn(),
    inspectWindowsGatewayFirewall: vi.fn(),
    summarizeExistingConfig: vi.fn(),
    healthCommand: vi.fn(),
    formatHealthCheckFailure: vi.fn<typeof import("./health-format.js").formatHealthCheckFailure>(),
    maybeInstallDaemon: vi.fn<typeof import("./configure.daemon.js").maybeInstallDaemon>(),
    promptAuthConfig: vi.fn(),
    promptGatewayConfig: vi.fn(),
    promptRemoteGatewayConfig: vi.fn(async (cfg: OpenClawConfig): Promise<OpenClawConfig> => ({
      ...cfg,
      gateway: { mode: "remote", remote: { url: "wss://gateway.example.test" } },
    })),
    isCodexNativeWebSearchRelevant: vi.fn(({ config }: { config: OpenClawConfig }) =>
      Boolean(config.auth?.profiles?.["openai:default"]),
    ),
    setupChannels: vi.fn<typeof import("../flows/channel-setup.js").setupChannels>(
      async (cfg) => cfg,
    ),
    guardCancel: vi.fn((value: unknown, _runtime: RuntimeEnv, _exitCode?: number) => value),
  };
});

vi.mock("../runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime.js")>();
  return {
    ...actual,
    defaultRuntime: { ...actual.defaultRuntime, ...wizardTestMocks.runtime },
  };
});

vi.mock("../cli/terminal-interactivity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/terminal-interactivity.js")>()),
  isTerminalInteractive: wizardTestMocks.isTerminalInteractive,
}));

vi.mock("@clack/prompts", () => ({
  intro: wizardTestMocks.clackIntro,
  outro: wizardTestMocks.clackOutro,
  select: wizardTestMocks.clackSelect,
  text: wizardTestMocks.clackText,
  confirm: wizardTestMocks.clackConfirm,
  password: wizardTestMocks.clackPassword,
}));

vi.mock("../flows/memory-setup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../flows/memory-setup.js")>()),
  runMemorySetupFlow: wizardTestMocks.runMemorySetupFlow,
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  const io: ConfigMutationIO = {
    readConfigFileSnapshotForWrite: async () => {
      const snapshot: Partial<ConfigFileSnapshot> & Pick<ConfigFileSnapshot, "config"> =
        await wizardTestMocks.readConfigFileSnapshot();
      return {
        snapshot: {
          ...createTestConfigSnapshot(
            snapshot.sourceConfig ?? snapshot.config,
            snapshot.runtimeConfig ?? snapshot.config,
          ),
          ...snapshot,
        },
        writeOptions: {
          assertConfigPathForWrite: wizardTestMocks.assertConfigPathForWrite,
          expectedConfigPath: "/tmp/openclaw.json",
          ownedConfigPathForWrite: "/tmp/openclaw.json",
        },
      };
    },
    writeConfigFile: wizardTestMocks.writeConfigFile,
  };
  return {
    ...actual,
    CONFIG_PATH: "~/.openclaw/openclaw.json",
    createConfigIO: () => io,
    readConfigFileSnapshot: wizardTestMocks.readConfigFileSnapshot,
    readConfigFileSnapshotForWrite: async () => {
      const prepared = await io.readConfigFileSnapshotForWrite();
      return {
        ...prepared,
        writeOptions: {
          ...prepared.writeOptions,
          envSnapshotForRestore: { SECRET: "resolved-secret" },
          includeFileHashesForWrite: { "/tmp/plugins.json5": "stale-hash" },
        },
      };
    },
    transformConfigFileWithRetry: (
      params: Parameters<typeof actual.transformConfigFileWithRetry>[0],
    ) => actual.transformConfigFileWithRetry({ ...params, io }),
    writeConfigFile: wizardTestMocks.writeConfigFile,
    replaceConfigFile: wizardTestMocks.replaceConfigFile,
    resolveGatewayPort: wizardTestMocks.resolveGatewayPort,
  };
});

vi.mock("../infra/windows-gateway-firewall-diagnostics.js", () => ({
  inspectWindowsGatewayFirewall: wizardTestMocks.inspectWindowsGatewayFirewall,
  formatWindowsGatewayFirewallGuidance: (params: { bind?: string }) =>
    params.bind === "lan"
      ? [
          "Windows firewall: if another device cannot connect to the LAN URL, run `openclaw gateway status --deep` from this Windows host.",
        ]
      : [],
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: wizardTestMocks.createClackPrompter,
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: wizardTestMocks.note,
}));

vi.mock("./onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "~/.openclaw/workspace",
  applyWizardMetadata: (cfg: OpenClawConfig) => cfg,
  ensureWorkspaceAndSessions: wizardTestMocks.ensureWorkspaceAndSessions,
  guardCancel: wizardTestMocks.guardCancel,
  printWizardHeader: wizardTestMocks.printWizardHeader,
  probeGatewayReachable: wizardTestMocks.probeGatewayReachable,
  resolveAdvertisedControlUiLinks: wizardTestMocks.resolveAdvertisedControlUiLinks,
  resolveControlUiLinks: wizardTestMocks.resolveControlUiLinks,
  resolveLocalControlUiProbeLinks: wizardTestMocks.resolveLocalControlUiProbeLinks,
  summarizeExistingConfig: wizardTestMocks.summarizeExistingConfig,
  waitForGatewayReachable: wizardTestMocks.waitForGatewayReachable,
}));

vi.mock("./health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./health.js")>()),
  healthCommandNonExiting: wizardTestMocks.healthCommand,
}));

vi.mock("./health-format.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./health-format.js")>();
  wizardTestMocks.formatHealthCheckFailure = vi.fn(actual.formatHealthCheckFailure);
  return { ...actual, formatHealthCheckFailure: wizardTestMocks.formatHealthCheckFailure };
});

vi.mock("./configure.gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./configure.gateway.js")>()),
  promptGatewayConfig: wizardTestMocks.promptGatewayConfig,
}));

vi.mock("./configure.gateway-auth.js", () => ({
  promptAuthConfig: wizardTestMocks.promptAuthConfig,
}));

vi.mock("./configure.daemon.js", () => ({
  maybeInstallDaemon: wizardTestMocks.maybeInstallDaemon,
}));

vi.mock("./onboard-remote.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./onboard-remote.js")>()),
  promptRemoteGatewayConfig: wizardTestMocks.promptRemoteGatewayConfig,
}));

vi.mock("./onboard-skills.js", () => ({
  setupSkills: wizardTestMocks.setupSkills,
}));

vi.mock("../wizard/setup.plugin-config.js", () => ({
  configurePluginConfig: wizardTestMocks.setupPluginConfig,
}));

vi.mock("../flows/channel-setup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../flows/channel-setup.js")>()),
  setupChannels: wizardTestMocks.setupChannels,
}));

vi.mock("../flows/search-setup.js", () => ({
  resolveSearchProviderOptions: wizardTestMocks.resolveSearchProviderOptions,
  runSearchSetupFlow: wizardTestMocks.setupSearch,
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  resolvePluginContributionOwners: wizardTestMocks.resolvePluginContributionOwners,
}));

vi.mock("../agents/codex-native-web-search.js", () => ({
  isCodexNativeWebSearchRelevant: wizardTestMocks.isCodexNativeWebSearchRelevant,
}));

// Load the wizard through this fixture so mocks register before its dependencies.
const { runConfigureWizard } = await import("./configure.wizard.js");
export { runConfigureWizard, wizardTestMocks };

export function setupWizardTestDefaults() {
  wizardTestMocks.isTerminalInteractive.mockReturnValue(true);
  committedConfigFiles.clear();
  wizardTestMocks.assertConfigPathForWrite.mockImplementation(() => {});
  wizardTestMocks.resolvePluginContributionOwners.mockReturnValue(["firecrawl"]);
  wizardTestMocks.resolveSearchProviderOptions.mockReturnValue([
    {
      id: "firecrawl",
      label: "Firecrawl Search",
      hint: "Structured results with optional result scraping",
      credentialLabel: "Firecrawl API key",
      envVars: ["FIRECRAWL_API_KEY"],
      placeholder: "fc-...",
      signupUrl: "https://www.firecrawl.dev/",
      credentialPath: "plugins.entries.firecrawl.config.webSearch.apiKey",
    },
  ]);
  wizardTestMocks.setupSearch.mockImplementation(async (cfg: OpenClawConfig) => ({
    outcome: "completed",
    config: cfg,
  }));
  wizardTestMocks.promptAuthConfig.mockImplementation(async (cfg: OpenClawConfig) => cfg);
  wizardTestMocks.promptGatewayConfig.mockImplementation(async (cfg: OpenClawConfig) => ({
    config: cfg,
    port: 18789,
  }));
  wizardTestMocks.guardCancel.mockImplementation((value: unknown) => value);
  wizardTestMocks.setupPluginConfig.mockImplementation(async ({ config }) => config);
  wizardTestMocks.setupSkills.mockImplementation(async (config) => config);
}

export const EMPTY_CONFIG_SNAPSHOT = {
  exists: false,
  valid: true,
  config: {},
  issues: [],
};

export function setupBaseWizardTestState(config: OpenClawConfig = {}) {
  wizardTestMocks.runMemorySetupFlow.mockImplementation(async (candidate) => candidate);
  wizardTestMocks.readConfigFileSnapshot.mockResolvedValue({ ...EMPTY_CONFIG_SNAPSHOT, config });
  wizardTestMocks.resolveGatewayPort.mockReturnValue(18789);
  wizardTestMocks.probeGatewayReachable.mockResolvedValue({ ok: false });
  wizardTestMocks.resolveControlUiLinks.mockReturnValue({ wsUrl: "ws://127.0.0.1:18789" });
  wizardTestMocks.resolveLocalControlUiProbeLinks.mockReturnValue({
    httpUrl: "http://127.0.0.1:18789/",
    wsUrl: "ws://127.0.0.1:18789",
  });
  wizardTestMocks.resolveAdvertisedControlUiLinks.mockResolvedValue({
    httpUrl: "http://127.0.0.1:18789/",
    wsUrl: "ws://127.0.0.1:18789",
  });
  wizardTestMocks.inspectWindowsGatewayFirewall.mockResolvedValue({
    applies: false,
    severity: "info",
    code: "windows_firewall_not_applicable",
    message: "Windows LAN firewall diagnostics do not apply.",
    details: [],
  });
  wizardTestMocks.summarizeExistingConfig.mockReturnValue("");
  wizardTestMocks.createClackPrompter.mockReturnValue({
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select: vi.fn(async () => "firecrawl"),
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => ""),
    confirm: vi.fn(async () => true),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  });
}

export function queueWizardTestPrompts(params: {
  select: string[];
  confirm: boolean[];
  text?: string;
}) {
  const selectQueue = [...params.select];
  const confirmQueue = [...params.confirm];
  wizardTestMocks.clackSelect.mockImplementation(async () => selectQueue.shift());
  wizardTestMocks.clackConfirm.mockImplementation(async () => confirmQueue.shift());
  wizardTestMocks.clackText.mockResolvedValue(params.text ?? "");
  wizardTestMocks.clackIntro.mockResolvedValue(undefined);
  wizardTestMocks.clackOutro.mockResolvedValue(undefined);
}
