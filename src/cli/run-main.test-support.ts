import process from "node:process";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi, type MockInstance } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ConfigSnapshotReadOptions } from "../config/io.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { GATEWAY_SERVICE_RUNTIME_PID_ENV } from "../daemon/constants.js";
import { loggingState } from "../logging/state.js";
import type { LocalOnboardingState } from "../state/local-onboarding-state.js";
import { captureEnv } from "../test-utils/env.js";
import type { RootHelpRenderOptions } from "./program/root-help.js";

const cliArgs = (...args: string[]) => ["node", "openclaw", ...args];

const readOnlyCoreOptions = { isolateEnv: true, observe: false, pluginValidation: "core-only" };

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type RunMainModule = typeof import("./run-main.js");

let runCli: RunMainModule["runCli"];

export type ConfigSnapshotStub = {
  exists: boolean;
  hash?: string;
  issues?: Array<{ message: string; path: string }>;
  legacyIssues?: Array<{ message: string; path: string }>;
  path?: string;
  raw?: string | null;
  valid: boolean;
  sourceConfig: Record<string, unknown>;
};

const tryRouteCliMock = vi.hoisted(() => vi.fn());
const loadDotEnvMock = vi.hoisted(() => vi.fn());
const dotenvModuleImportState = vi.hoisted(() => ({ count: 0 }));
const existsSyncOverride = vi.hoisted(
  () =>
    ({ value: undefined }) as {
      value: ((target: string) => boolean) | undefined;
    },
);
const assertRuntimeMock = vi.hoisted(() => vi.fn(async () => {}));
const isCurrentRuntimeSupportedMock = vi.hoisted(() => vi.fn(async () => true));
const closeActiveMemorySearchManagersMock = vi.hoisted(() => vi.fn(async () => {}));
const hasMemoryRuntimeMock = vi.hoisted(() => vi.fn(() => false));
const listRegisteredAgentHarnessesMock = vi.hoisted(() => vi.fn((): unknown[] => []));
const disposeRegisteredAgentHarnessesMock = vi.hoisted(() => vi.fn(async () => {}));
const hasProviderTransportDispatcherPoolMock = vi.hoisted(() => vi.fn(() => false));
const stopManagedProviderLocalServicesMock = vi.hoisted(() => vi.fn());
const closeProviderTransportDispatcherPoolMock = vi.hoisted(() => vi.fn(async () => {}));
const getActiveMcpLoopbackRuntimeMock = vi.hoisted(() =>
  vi.fn<() => { port: number } | undefined>(() => undefined),
);
const closeMcpLoopbackServerMock = vi.hoisted(() => vi.fn(async () => {}));
const outputRootHelpMock = vi.hoisted(() => vi.fn());
const outputPrecomputedRootHelpTextMock = vi.hoisted(() => vi.fn(() => false));
const outputPrecomputedBrowserHelpTextMock = vi.hoisted(() => vi.fn(() => false));
const outputPrecomputedSecretsHelpTextMock = vi.hoisted(() => vi.fn(() => false));
const outputPrecomputedNodesHelpTextMock = vi.hoisted(() => vi.fn(() => false));
const outputPrecomputedSubcommandHelpTextMock = vi.hoisted(() => vi.fn(() => false));
const loadRootHelpRenderOptionsForConfigSensitivePluginsMock = vi.hoisted(() =>
  vi.fn<() => Promise<RootHelpRenderOptions | null>>(async () => null),
);
const tryOutputSetupOnboardConfigureHelpMock = vi.hoisted(() => vi.fn(async () => true));
const buildProgramMock = vi.hoisted(() => vi.fn());
const parkCurrentLaunchAgentForMaintenanceMock = vi.hoisted(() => vi.fn(async () => true));
const getProgramContextMock = vi.hoisted(() => vi.fn(() => null));
const registerCoreCliByNameMock = vi.hoisted(() => vi.fn());
const registerSubCliByNameMock = vi.hoisted(() => vi.fn());
const registerPluginCliCommandsFromValidatedConfigMock = vi.hoisted(() => vi.fn(async () => ({})));
const resolvePluginCliRootOwnerIdsMock = vi.hoisted(() => vi.fn());
const createPluginCliLoadSessionMock = vi.hoisted(() =>
  vi.fn(() => ({
    readConfig: <T>(read: () => Promise<T>) => read(),
    withCache: <T>(run: () => T) => run(),
    close: vi.fn(),
  })),
);
const loadPluginCliDescriptorsMock = vi.hoisted(() =>
  vi.fn<
    () => Promise<
      Array<{
        name: string;
        description: string;
        hasSubcommands: boolean;
        machineOutput?: (params: { argv: readonly string[]; stdoutIsTTY: boolean }) => boolean;
      }>
    >
  >(async () => []),
);
const resolveManifestCommandAliasOwnerMock = vi.hoisted(() => vi.fn());
const resolveManifestToolOwnerMock = vi.hoisted(() => vi.fn());
const resolveManifestCliCommandSurfaceOwnerMock = vi.hoisted(() => vi.fn());
const restoreRuntimeTerminalStateMock = vi.hoisted(() => vi.fn());
const hasEnvHttpProxyAgentConfiguredMock = vi.hoisted(() => vi.fn(() => false));
const ensureGlobalUndiciEnvProxyDispatcherMock = vi.hoisted(() => vi.fn());
const readConfigFileSnapshotMock = vi.hoisted(() =>
  vi.fn<(options?: ConfigSnapshotReadOptions) => Promise<ConfigSnapshotStub>>(async () =>
    validConfig({ gateway: { mode: "local" } }),
  ),
);
const readLocalOnboardingStateMock = vi.hoisted(() =>
  vi.fn<
    (
      configPath: string,
      config: { wizard?: { securityAcknowledgedAt?: string } },
    ) => LocalOnboardingState | undefined
  >(() => undefined),
);
const setupWizardCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const runRemoteGatewayInferenceOnboardingMock = vi.hoisted(() => vi.fn(async () => {}));
const runTuiMock = vi.hoisted(() => vi.fn<(opts: unknown) => Promise<void>>(async () => {}));
const runTuiCliActionMock = vi.hoisted(() =>
  vi.fn<(target: string | undefined, opts: unknown) => Promise<void>>(async () => {}),
);
const probeGatewayConfiguredModelMock = vi.hoisted(() =>
  vi.fn<typeof import("../commands/onboard-helpers.js").probeGatewayConfiguredModel>(async () => ({
    kind: "configured",
  })),
);
const readActiveGatewayLockPortMock = vi.hoisted(() =>
  vi.fn(async (): Promise<number | undefined> => undefined),
);
const inspectGatewayTlsCertificateMock = vi.hoisted(() =>
  vi.fn<typeof import("../infra/tls/gateway.js").inspectGatewayTlsCertificate>(async () => ({
    ok: false,
    error: "gateway tls is disabled",
  })),
);
const resolveControlUiLinksMock = vi.hoisted(() =>
  vi.fn(() => ({
    httpUrl: "http://127.0.0.1:18789/",
    wsUrl: "ws://127.0.0.1:18789",
  })),
);
const commanderParseAsyncMock = vi.hoisted(() => vi.fn(async () => {}));
type GatewayRunCommandHooks = {
  beforeRun?: (opts: { reset?: boolean }) => Promise<void>;
};
type CliExecutionBootstrapOptions = {
  beforeStatePreparation?: (snapshot?: ConfigSnapshotStub) => Promise<boolean>;
};
const addGatewayRunCommandMock = vi.hoisted(() =>
  vi.fn<(command: unknown, hooks?: GatewayRunCommandHooks) => unknown>((command) => command),
);
const ensureCliExecutionBootstrapMock = vi.hoisted(() =>
  vi.fn<(_opts: CliExecutionBootstrapOptions) => Promise<void>>(async () => {}),
);
const emitCliBannerMock = vi.hoisted(() => vi.fn());
const enableConsoleCaptureMock = vi.hoisted(() => vi.fn());
const progressDoneMock = vi.hoisted(() => vi.fn());
const createCliProgressMock = vi.hoisted(() => vi.fn(() => ({ done: progressDoneMock })));
const loadConfigMock = vi.hoisted(() =>
  vi.fn<
    (...args: Parameters<typeof import("../config/io.js").readBestEffortConfig>) => OpenClawConfig
  >(() => ({})),
);
const readSourceConfigBestEffortMock = vi.hoisted(() => vi.fn(async () => ({})));
const startProxyMock = vi.hoisted(() =>
  vi.fn<(config: unknown) => Promise<unknown>>(async () => null),
);
const stopProxyMock = vi.hoisted(() => vi.fn<(handle: unknown) => Promise<void>>(async () => {}));
const flushExitAfterOneShotOutputMock = vi.hoisted(() => vi.fn());
const requestExitAfterOneShotOutputMock = vi.hoisted(() => vi.fn());
const maybeRunCliInContainerMock = vi.hoisted(() =>
  vi.fn<
    (argv: string[]) => { handled: true; exitCode: number } | { handled: false; argv: string[] }
  >((argv: string[]) => ({ handled: false, argv })),
);
const serviceEnvSnapshot = captureEnv([
  "OPENCLAW_SERVICE_MARKER",
  "OPENCLAW_SERVICE_KIND",
  GATEWAY_SERVICE_RUNTIME_PID_ENV,
]);

vi.mock("commander", () => {
  class MockCommanderError extends Error {
    exitCode: number;
    code: string;

    constructor(exitCode: number, code: string, message: string) {
      super(message);
      this.exitCode = exitCode;
      this.code = code;
    }
  }

  class MockCommand {
    name = vi.fn(() => this);
    enablePositionalOptions = vi.fn(() => this);
    option = vi.fn(() => this);
    exitOverride = vi.fn(() => this);
    description = vi.fn(() => this);
    command = vi.fn(() => new MockCommand());
    parseAsync = commanderParseAsyncMock;
  }

  return { Command: MockCommand, CommanderError: MockCommanderError };
});

vi.mock("./route.js", () => ({ tryRouteCli: tryRouteCliMock }));

vi.mock("./gateway-cli/run-command.js", () => ({ addGatewayRunCommand: addGatewayRunCommandMock }));

vi.mock("../daemon/launchd.js", () => ({
  parkCurrentLaunchAgentForMaintenance: parkCurrentLaunchAgentForMaintenanceMock,
}));

vi.mock("./command-execution-startup.js", () => ({
  ensureCliExecutionBootstrap: ensureCliExecutionBootstrapMock,
}));

vi.mock("../version.js", () => ({
  VERSION: "9.9.9-test",
  resolveRuntimeServiceCommit: () => null,
}));

vi.mock("./banner.js", () => ({ emitCliBanner: emitCliBannerMock }));

vi.mock("../logging/console.js", async () => ({
  ...(await vi.importActual<typeof import("../logging/console.js")>("../logging/console.js")),
  enableConsoleCapture: enableConsoleCaptureMock,
}));

vi.mock("./container-target.js", () => ({
  maybeRunCliInContainer: maybeRunCliInContainerMock,
  parseCliContainerArgs: (argv: string[]) => ({ ok: true, container: null, argv }),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (target: Parameters<typeof actual.existsSync>[0]) =>
      typeof target === "string" && existsSyncOverride.value
        ? existsSyncOverride.value(target)
        : actual.existsSync(target),
  };
});

vi.mock("./dotenv.js", () => {
  dotenvModuleImportState.count += 1;
  return { loadCliDotEnv: loadDotEnvMock };
});

vi.mock("./one-shot-exit.js", () => ({
  flushExitAfterOneShotOutput: flushExitAfterOneShotOutputMock,
  requestExitAfterOneShotOutput: requestExitAfterOneShotOutputMock,
}));

vi.mock("../infra/env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/env.js")>()),
  normalizeEnv: vi.fn(),
}));

vi.mock("../config/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/paths.js")>()),
  pinRuntimePaths: vi.fn(),
}));

vi.mock("../gateway/control-ui-links.js", () => ({
  resolveControlUiLinks: resolveControlUiLinksMock,
}));

vi.mock("../infra/gateway-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/gateway-lock.js")>()),
  readActiveGatewayLockPort: readActiveGatewayLockPortMock,
}));

vi.mock("../infra/tls/gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/tls/gateway.js")>()),
  inspectGatewayTlsCertificate: inspectGatewayTlsCertificateMock,
}));

vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  pinConfigDir: vi.fn(),
}));

vi.mock("../infra/path-env.js", () => ({ ensureOpenClawCliOnPath: vi.fn() }));

vi.mock("../infra/runtime-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/runtime-guard.js")>()),
  assertSupportedRuntime: assertRuntimeMock,
  isCurrentRuntimeSupported: isCurrentRuntimeSupportedMock,
}));

vi.mock("../plugins/memory-runtime.js", () => ({
  closeActiveMemorySearchManagersCore: closeActiveMemorySearchManagersMock,
}));

vi.mock("../plugins/memory-state.js", () => ({ hasMemoryRuntime: hasMemoryRuntimeMock }));

vi.mock("../agents/harness/registry.js", () => ({
  listRegisteredAgentHarnesses: listRegisteredAgentHarnessesMock,
  disposeRegisteredAgentHarnesses: disposeRegisteredAgentHarnessesMock,
}));

vi.mock("../agents/provider-runtime-lifecycle.js", () => ({
  stopActiveManagedProviderLocalServices: stopManagedProviderLocalServicesMock,
  hasProviderTransportDispatcherPool: hasProviderTransportDispatcherPoolMock,
}));

vi.mock("../agents/provider-local-service.js", () => {
  return { stopManagedProviderLocalServices: stopManagedProviderLocalServicesMock };
});

vi.mock("../agents/provider-transport-dispatcher-pool.js", () => {
  return { closeProviderTransportDispatcherPool: closeProviderTransportDispatcherPoolMock };
});

vi.mock("../gateway/mcp-http.loopback-runtime.js", () => ({
  getActiveMcpLoopbackRuntime: getActiveMcpLoopbackRuntimeMock,
}));

vi.mock("../gateway/mcp-http.js", () => ({ closeMcpLoopbackServer: closeMcpLoopbackServerMock }));

vi.mock("./program/root-help.js", () => ({ outputRootHelp: outputRootHelpMock }));

vi.mock("./root-help-metadata.js", () => ({
  outputPrecomputedBrowserHelpText: outputPrecomputedBrowserHelpTextMock,
  outputPrecomputedNodesHelpText: outputPrecomputedNodesHelpTextMock,
  outputPrecomputedRootHelpText: outputPrecomputedRootHelpTextMock,
  outputPrecomputedSecretsHelpText: outputPrecomputedSecretsHelpTextMock,
  outputPrecomputedSubcommandHelpText: outputPrecomputedSubcommandHelpTextMock,
}));

vi.mock("./root-help-live-config.js", () => ({
  loadRootHelpRenderOptionsForConfigSensitivePlugins:
    loadRootHelpRenderOptionsForConfigSensitivePluginsMock,
}));

vi.mock("./setup-onboard-configure-help-fast-path.js", () => ({
  tryOutputSetupOnboardConfigureHelp: tryOutputSetupOnboardConfigureHelpMock,
}));

vi.mock("./program.js", () => ({ buildProgram: buildProgramMock }));

vi.mock("./program/program-context.js", () => ({ getProgramContext: getProgramContextMock }));

vi.mock("./program/command-registry-core.js", () => ({
  registerCoreCliByName: registerCoreCliByNameMock,
}));

vi.mock("./program/register.subclis.js", () => ({
  registerSubCliByName: registerSubCliByNameMock,
}));

vi.mock("../plugins/cli.js", () => ({
  registerPluginCliCommandsFromValidatedConfig: registerPluginCliCommandsFromValidatedConfigMock,
}));

vi.mock("../plugins/cli-registry-loader.js", () => ({
  loadPluginCliDescriptors: loadPluginCliDescriptorsMock,
  createPluginCliLoadSession: createPluginCliLoadSessionMock,
  resolvePluginCliRootOwnerIds: resolvePluginCliRootOwnerIdsMock,
}));

vi.mock("../plugins/manifest-command-aliases.runtime.js", () => ({
  resolveManifestCliCommandSurfaceOwner: resolveManifestCliCommandSurfaceOwnerMock,
  resolveManifestCommandAliasOwner: resolveManifestCommandAliasOwnerMock,
  resolveManifestToolOwner: resolveManifestToolOwnerMock,
}));

vi.mock("../runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime.js")>();
  return {
    ...actual,
    restoreRuntimeTerminalState: restoreRuntimeTerminalStateMock,
  };
});

vi.mock("../infra/net/proxy-env.js", () => ({
  hasEnvHttpProxyAgentConfigured: hasEnvHttpProxyAgentConfiguredMock,
}));

vi.mock("../infra/net/undici-global-dispatcher.js", () => ({
  ensureGlobalUndiciEnvProxyDispatcher: ensureGlobalUndiciEnvProxyDispatcherMock,
}));

vi.mock("../config/config.js", () => ({ readConfigFileSnapshot: readConfigFileSnapshotMock }));

vi.mock("../state/local-onboarding-state.js", () => ({
  readLocalOnboardingStateForConfig: readLocalOnboardingStateMock,
}));

vi.mock("../commands/onboard.js", () => ({ setupWizardCommand: setupWizardCommandMock }));

vi.mock("../commands/onboard-remote-gateway.js", () => ({
  runRemoteGatewayInferenceOnboarding: runRemoteGatewayInferenceOnboardingMock,
}));

vi.mock("../commands/onboard-helpers.js", () => ({
  probeGatewayConfiguredModel: probeGatewayConfiguredModelMock,
}));

vi.mock("../tui/tui.js", () => ({ runTui: runTuiMock }));

vi.mock("./tui-cli.js", () => ({ runTuiCliAction: runTuiCliActionMock }));

vi.mock("./progress.js", () => ({ createCliProgress: createCliProgressMock }));

vi.mock("../config/io.js", () => ({
  readBestEffortConfig: loadConfigMock,
  readBestEffortConfigSnapshot: async (...args: Parameters<typeof loadConfigMock>) => ({
    config: loadConfigMock(...args),
  }),
  readSourceConfigBestEffort: readSourceConfigBestEffortMock,
}));

vi.mock("../infra/net/proxy/proxy-lifecycle.js", () => ({
  startProxy: startProxyMock,
  stopProxy: stopProxyMock,
}));

async function withCliExitSpies(
  run: (
    errorSpy: MockInstance<typeof console.error>,
    exitSpy: MockInstance<typeof process.exit>,
  ) => Promise<void>,
): Promise<void> {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit:${String(code)}`);
  });
  try {
    await run(errorSpy, exitSpy);
  } finally {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  }
}

async function runGatewayBeforeHook(opts: { reset?: boolean } = {}): Promise<void> {
  await addGatewayRunCommandMock.mock.calls[0]?.[1]?.beforeRun?.(opts);
}

function makeProgram<T>(primary: string | undefined, parseAsync: T) {
  return { commands: [{ name: () => primary, aliases: () => [] }], parseAsync };
}

function validConfig(
  sourceConfig: ConfigSnapshotStub["sourceConfig"],
  overrides: Partial<Omit<ConfigSnapshotStub, "sourceConfig">> = {},
): ConfigSnapshotStub {
  return { exists: true, valid: true, sourceConfig, ...overrides };
}

export {
  cliArgs,
  readOnlyCoreOptions,
  tempDirs,
  runCli,
  tryRouteCliMock,
  loadDotEnvMock,
  existsSyncOverride,
  assertRuntimeMock,
  isCurrentRuntimeSupportedMock,
  closeActiveMemorySearchManagersMock,
  hasMemoryRuntimeMock,
  listRegisteredAgentHarnessesMock,
  disposeRegisteredAgentHarnessesMock,
  hasProviderTransportDispatcherPoolMock,
  stopManagedProviderLocalServicesMock,
  closeProviderTransportDispatcherPoolMock,
  getActiveMcpLoopbackRuntimeMock,
  closeMcpLoopbackServerMock,
  outputRootHelpMock,
  outputPrecomputedRootHelpTextMock,
  outputPrecomputedNodesHelpTextMock,
  loadRootHelpRenderOptionsForConfigSensitivePluginsMock,
  tryOutputSetupOnboardConfigureHelpMock,
  buildProgramMock,
  parkCurrentLaunchAgentForMaintenanceMock,
  getProgramContextMock,
  registerCoreCliByNameMock,
  registerSubCliByNameMock,
  registerPluginCliCommandsFromValidatedConfigMock,
  resolvePluginCliRootOwnerIdsMock,
  createPluginCliLoadSessionMock,
  loadPluginCliDescriptorsMock,
  resolveManifestCommandAliasOwnerMock,
  resolveManifestToolOwnerMock,
  restoreRuntimeTerminalStateMock,
  hasEnvHttpProxyAgentConfiguredMock,
  ensureGlobalUndiciEnvProxyDispatcherMock,
  readConfigFileSnapshotMock,
  readLocalOnboardingStateMock,
  setupWizardCommandMock,
  runRemoteGatewayInferenceOnboardingMock,
  runTuiMock,
  runTuiCliActionMock,
  probeGatewayConfiguredModelMock,
  readActiveGatewayLockPortMock,
  inspectGatewayTlsCertificateMock,
  resolveControlUiLinksMock,
  commanderParseAsyncMock,
  addGatewayRunCommandMock,
  ensureCliExecutionBootstrapMock,
  emitCliBannerMock,
  enableConsoleCaptureMock,
  progressDoneMock,
  createCliProgressMock,
  loadConfigMock,
  readSourceConfigBestEffortMock,
  startProxyMock,
  stopProxyMock,
  flushExitAfterOneShotOutputMock,
  requestExitAfterOneShotOutputMock,
  maybeRunCliInContainerMock,
  withCliExitSpies,
  runGatewayBeforeHook,
  makeProgram,
  validConfig,
};

export function installRunMainTestHooks(): void {
  beforeAll(async () => {
    expect(dotenvModuleImportState.count).toBe(0);
    const runMainModule = await import("./run-main.js");
    expect(dotenvModuleImportState.count).toBe(0);
    runCli = runMainModule.runCli;
  });

  afterAll(() => {
    serviceEnvSnapshot.restore();
  });

  beforeEach(() => {
    delete process.env.OPENCLAW_SERVICE_MARKER;
    delete process.env.OPENCLAW_SERVICE_KIND;
    // Sibling CLI suites run `gateway run --token/--password`, which exports
    // credentials into process.env; leaked values change gateway preflight
    // auth in shared vitest workers.
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    delete process.env[GATEWAY_SERVICE_RUNTIME_PID_ENV];
    existsSyncOverride.value = undefined;
    vi.clearAllMocks();
    readConfigFileSnapshotMock.mockResolvedValue(validConfig({ gateway: { mode: "local" } }));
    readLocalOnboardingStateMock.mockReset().mockReturnValue(undefined);
    probeGatewayConfiguredModelMock.mockResolvedValue({ kind: "configured" });
    readActiveGatewayLockPortMock.mockReset().mockResolvedValue(undefined);
    inspectGatewayTlsCertificateMock
      .mockReset()
      .mockResolvedValue({ ok: false, error: "gateway tls is disabled" });
    resolveControlUiLinksMock.mockReturnValue({
      httpUrl: "http://127.0.0.1:18789/",
      wsUrl: "ws://127.0.0.1:18789",
    });
    hasMemoryRuntimeMock.mockReturnValue(false);
    listRegisteredAgentHarnessesMock.mockReturnValue([]);
    hasProviderTransportDispatcherPoolMock.mockReturnValue(false);
    outputPrecomputedBrowserHelpTextMock.mockReturnValue(false);
    outputPrecomputedNodesHelpTextMock.mockReturnValue(false);
    outputPrecomputedRootHelpTextMock.mockReturnValue(false);
    outputPrecomputedSecretsHelpTextMock.mockReturnValue(false);
    outputPrecomputedSubcommandHelpTextMock.mockReturnValue(false);
    loadRootHelpRenderOptionsForConfigSensitivePluginsMock.mockResolvedValue(null);
    tryOutputSetupOnboardConfigureHelpMock.mockResolvedValue(true);
    hasEnvHttpProxyAgentConfiguredMock.mockReturnValue(false);
    loadConfigMock.mockReturnValue({});
    startProxyMock.mockResolvedValue(null);
    stopProxyMock.mockResolvedValue(undefined);
    getProgramContextMock.mockReturnValue(null);
    loadPluginCliDescriptorsMock.mockReset().mockResolvedValue([]);
    resolvePluginCliRootOwnerIdsMock.mockImplementation(
      ({ primaryCommand }: { primaryCommand?: string }) =>
        primaryCommand === "googlemeet" ? ["google-meet"] : [],
    );
    resolveManifestCommandAliasOwnerMock.mockReturnValue(undefined);
    resolveManifestToolOwnerMock.mockReturnValue(undefined);
    resolveManifestCliCommandSurfaceOwnerMock.mockReturnValue(undefined);
    delete process.env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH;
    delete process.env.OPENCLAW_HIDE_BANNER;
    loggingState.forceConsoleToStderr = false;
  });
}
