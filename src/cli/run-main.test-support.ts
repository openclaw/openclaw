import process from "node:process";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi, type MockInstance } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ConfigSnapshotReadOptions } from "../config/io.types.js";
import { createSnapshot } from "../config/mutate.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { GATEWAY_SERVICE_RUNTIME_PID_ENV } from "../daemon/constants.js";
import { loggingState } from "../logging/state.js";
import type { RuntimeEnv } from "../runtime.js";
import type { LocalOnboardingState } from "../state/local-onboarding-state.js";
import { captureEnv } from "../test-utils/env.js";
import type { RootHelpRenderOptions } from "./program/root-help.js";

const cliArgs = (...args: string[]) => ["node", "openclaw", ...args];

const readOnlyCoreOptions = { isolateEnv: true, observe: false, pluginValidation: "core-only" };

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type RunMainModule = typeof import("./run-main.js");

let runCli: RunMainModule["runCli"];
let startupConfig: typeof import("../commands/config-preflight-snapshot.js");

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

type GatewayRunCommandHooks = {
  beforeRun?: (opts: { reset?: boolean }) => Promise<void>;
};
type CliExecutionBootstrapOptions = {
  beforeStatePreparation?: (snapshot?: ConfigSnapshotStub) => Promise<boolean>;
};

const mocks = vi.hoisted(() => {
  const defaults: Array<() => void> = [];
  function value<T>(read: () => T) {
    const mock = vi.fn(read);
    defaults.push(() => {
      mock.mockReturnValue(read());
    });
    return mock;
  }
  const progressDoneMock = vi.fn();
  return {
    tryRouteCli: vi.fn(),
    loadDotEnv: vi.fn(),
    dotenvModuleImportState: { count: 0 },
    existsSyncOverride: { value: undefined } as {
      value: ((target: string) => boolean) | undefined;
    },
    assertRuntime: vi.fn(async () => {}),
    isCurrentRuntimeSupported: vi.fn(async () => true),
    closeActiveMemorySearchManagers: vi.fn(async () => {}),
    hasMemoryRuntime: value(() => false),
    listRegisteredAgentHarnesses: value((): unknown[] => []),
    disposeRegisteredAgentHarnesses: vi.fn(async () => {}),
    hasProviderTransportDispatcherPool: value(() => false),
    stopManagedProviderLocalServices: vi.fn(),
    closeProviderTransportDispatcherPool: vi.fn(async () => {}),
    getActiveMcpLoopbackRuntime: vi.fn<() => { port: number } | undefined>(() => undefined),
    closeMcpLoopbackServer: vi.fn(async () => {}),
    outputRootHelp: vi.fn(),
    outputPrecomputedRootHelpText: value(() => false),
    outputPrecomputedBrowserHelpText: value(() => false),
    outputPrecomputedSecretsHelpText: value(() => false),
    outputPrecomputedNodesHelpText: value(() => false),
    outputPrecomputedSubcommandHelpText: value(() => false),
    loadRootHelpRenderOptionsForConfigSensitivePlugins: vi.fn<
      () => Promise<RootHelpRenderOptions | null>
    >(async () => null),
    tryOutputSetupOnboardConfigureHelp: vi.fn(async () => true),
    buildProgram: vi.fn(),
    parkCurrentLaunchAgentForMaintenance: vi.fn(async () => true),
    getProgramContext: value(() => null),
    registerCoreCliByName: vi.fn(),
    registerSubCliByName: vi.fn(),
    registerPluginCliCommandsFromValidatedConfig: vi.fn(async () => ({})),
    resolvePluginCliRootOwnerIds: vi.fn(),
    createPluginCliLoadSession: vi.fn(() => ({
      readConfig: <T>(read: () => Promise<T>) => read(),
      withCache: <T>(run: () => T) => run(),
      close: vi.fn(),
    })),
    loadPluginCliDescriptors: vi.fn<
      () => Promise<
        Array<{
          name: string;
          description: string;
          hasSubcommands: boolean;
          machineOutput?: (params: { argv: readonly string[]; stdoutIsTTY: boolean }) => boolean;
        }>
      >
    >(async () => []),
    resolveManifestCommandAliasOwner: vi.fn(),
    resolveManifestToolOwner: vi.fn(),
    resolveManifestCliCommandSurfaceOwner: vi.fn(),
    restoreRuntimeTerminalState: vi.fn(),
    hasEnvHttpProxyAgentConfigured: value(() => false),
    ensureGlobalUndiciEnvProxyDispatcher: vi.fn(),
    readConfigFileSnapshot: vi.fn<
      (options?: ConfigSnapshotReadOptions) => Promise<ConfigSnapshotStub>
    >(async () => validConfig({ gateway: { mode: "local" } })),
    readLocalOnboardingState: vi.fn<
      (
        configPath: string,
        config: { wizard?: { securityAcknowledgedAt?: string } },
      ) => Promise<LocalOnboardingState | undefined>
    >(async () => undefined),
    setupWizardCommand: vi.fn(async () => {}),
    runRemoteGatewayInferenceOnboarding: vi.fn(async () => {}),
    runTui: vi.fn<(opts: unknown) => Promise<void>>(async () => {}),
    runTuiCliAction: vi.fn<(target: string | undefined, opts: unknown) => Promise<void>>(
      async () => {},
    ),
    probeGatewayConfiguredModel: vi.fn<
      typeof import("../commands/onboard-helpers.js").probeGatewayConfiguredModel
    >(async () => ({
      kind: "configured",
    })),
    readActiveGatewayLockPort: vi.fn(async (): Promise<number | undefined> => undefined),
    inspectGatewayTlsCertificate: vi.fn<
      typeof import("../infra/tls/gateway.js").inspectGatewayTlsCertificate
    >(async () => ({
      ok: false,
      error: "gateway tls is disabled",
    })),
    resolveControlUiLinks: value(() => ({
      httpUrl: "http://127.0.0.1:18789/",
      wsUrl: "ws://127.0.0.1:18789",
    })),
    commanderParseAsync: vi.fn(async () => {}),
    addGatewayRunCommand: vi.fn<(command: unknown, hooks?: GatewayRunCommandHooks) => unknown>(
      (command) => command,
    ),
    ensureCliExecutionBootstrap: vi.fn<(_opts: CliExecutionBootstrapOptions) => Promise<void>>(
      async () => {},
    ),
    emitCliBanner: vi.fn(),
    enableConsoleCapture: vi.fn(),
    progressDone: progressDoneMock,
    createCliProgress: vi.fn(() => ({ done: progressDoneMock })),
    loadConfig: vi.fn<
      (...args: Parameters<typeof import("../config/io.js").readBestEffortConfig>) => OpenClawConfig
    >(() => ({})),
    readSourceConfigBestEffort: vi.fn(async () => ({})),
    startProxy: vi.fn<(config: unknown) => Promise<unknown>>(async () => null),
    stopProxy: vi.fn<(handle: unknown) => Promise<void>>(async () => {}),
    flushExitAfterOneShotOutput: vi.fn(),
    requestExitAfterOneShotOutput: vi.fn(),
    resetDefaults: () => defaults.forEach((reset) => reset()),
    maybeRunCliInContainer: vi.fn<
      (argv: string[]) => { handled: true; exitCode: number } | { handled: false; argv: string[] }
    >((argv: string[]) => ({ handled: false, argv })),
  };
});
const serviceEnvSnapshot = captureEnv([
  "OPENCLAW_SERVICE_MARKER",
  "OPENCLAW_SERVICE_KIND",
  GATEWAY_SERVICE_RUNTIME_PID_ENV,
]);
vi.mock("commander", () => {
  class MockCommanderError extends Error {
    constructor(
      public exitCode: number,
      public code: string,
      message: string,
    ) {
      super(message);
    }
  }

  class MockCommand {
    name = vi.fn(() => this);
    enablePositionalOptions = vi.fn(() => this);
    option = vi.fn(() => this);
    exitOverride = vi.fn(() => this);
    description = vi.fn(() => this);
    command = vi.fn(() => new MockCommand());
    parseAsync = mocks.commanderParseAsync;
  }

  return { Command: MockCommand, CommanderError: MockCommanderError };
});
vi.mock("./route.js", () => ({ tryRouteCli: mocks.tryRouteCli }));
vi.mock("./gateway-cli/run-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gateway-cli/run-command.js")>()),
  addGatewayRunCommand: mocks.addGatewayRunCommand,
}));
vi.mock("../daemon/launchd.js", () => ({
  parkCurrentLaunchAgentForMaintenance: mocks.parkCurrentLaunchAgentForMaintenance,
}));
vi.mock("./command-execution-startup.js", () => ({
  ensureCliExecutionBootstrap: mocks.ensureCliExecutionBootstrap,
}));
vi.mock("../version.js", () => ({
  VERSION: "9.9.9-test",
  resolveRuntimeServiceCommit: () => null,
}));
vi.mock("./banner.js", () => ({ emitCliBanner: mocks.emitCliBanner }));
vi.mock("../logging/console.js", async () => ({
  ...(await vi.importActual<typeof import("../logging/console.js")>("../logging/console.js")),
  enableConsoleCapture: mocks.enableConsoleCapture,
}));
vi.mock("./container-target.js", () => ({
  maybeRunCliInContainer: mocks.maybeRunCliInContainer,
  parseCliContainerArgs: (argv: string[]) => ({ ok: true, container: null, argv }),
}));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (target: Parameters<typeof actual.existsSync>[0]) =>
      typeof target === "string" && mocks.existsSyncOverride.value
        ? mocks.existsSyncOverride.value(target)
        : actual.existsSync(target),
  };
});
vi.mock("./dotenv.js", () => {
  mocks.dotenvModuleImportState.count += 1;
  return { loadCliDotEnv: mocks.loadDotEnv };
});
vi.mock("./one-shot-exit.js", () => ({
  flushExitAfterOneShotOutput: mocks.flushExitAfterOneShotOutput,
  requestExitAfterOneShotOutput: mocks.requestExitAfterOneShotOutput,
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
  resolveControlUiLinks: mocks.resolveControlUiLinks,
}));
vi.mock("../infra/gateway-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/gateway-lock.js")>()),
  readActiveGatewayLockPort: mocks.readActiveGatewayLockPort,
}));
vi.mock("../infra/tls/gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/tls/gateway.js")>()),
  inspectGatewayTlsCertificate: mocks.inspectGatewayTlsCertificate,
}));
vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  pinConfigDir: vi.fn(),
}));
vi.mock("../infra/path-env.js", () => ({ ensureOpenClawCliOnPath: vi.fn() }));
vi.mock("../infra/runtime-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/runtime-guard.js")>()),
  assertSupportedRuntime: mocks.assertRuntime,
  isCurrentRuntimeSupported: mocks.isCurrentRuntimeSupported,
}));
vi.mock("../plugins/memory-runtime.js", () => ({
  closeActiveMemorySearchManagersCore: mocks.closeActiveMemorySearchManagers,
}));
vi.mock("../plugins/memory-state.js", () => ({ hasMemoryRuntime: mocks.hasMemoryRuntime }));
vi.mock("../agents/harness/registry.js", () => ({
  listRegisteredAgentHarnesses: mocks.listRegisteredAgentHarnesses,
  disposeRegisteredAgentHarnesses: mocks.disposeRegisteredAgentHarnesses,
}));
vi.mock("../agents/provider-runtime-lifecycle.js", () => ({
  stopActiveManagedProviderLocalServices: mocks.stopManagedProviderLocalServices,
  hasProviderTransportDispatcherPool: mocks.hasProviderTransportDispatcherPool,
}));
vi.mock("../agents/provider-local-service.js", () => {
  return { stopManagedProviderLocalServices: mocks.stopManagedProviderLocalServices };
});
vi.mock("../agents/provider-transport-dispatcher-pool.js", () => {
  return { closeProviderTransportDispatcherPool: mocks.closeProviderTransportDispatcherPool };
});
vi.mock("../gateway/mcp-http.loopback-runtime.js", () => ({
  getActiveMcpLoopbackRuntime: mocks.getActiveMcpLoopbackRuntime,
}));
vi.mock("../gateway/mcp-http.js", () => ({
  closeMcpLoopbackServer: mocks.closeMcpLoopbackServer,
}));
vi.mock("./program/root-help.js", () => ({ outputRootHelp: mocks.outputRootHelp }));
vi.mock("./root-help-metadata.js", () => ({
  outputPrecomputedBrowserHelpText: mocks.outputPrecomputedBrowserHelpText,
  outputPrecomputedNodesHelpText: mocks.outputPrecomputedNodesHelpText,
  outputPrecomputedRootHelpText: mocks.outputPrecomputedRootHelpText,
  outputPrecomputedSecretsHelpText: mocks.outputPrecomputedSecretsHelpText,
  outputPrecomputedSubcommandHelpText: mocks.outputPrecomputedSubcommandHelpText,
}));
vi.mock("./root-help-live-config.js", () => ({
  loadRootHelpRenderOptionsForConfigSensitivePlugins:
    mocks.loadRootHelpRenderOptionsForConfigSensitivePlugins,
}));
vi.mock("./setup-onboard-configure-help-fast-path.js", () => ({
  tryOutputSetupOnboardConfigureHelp: mocks.tryOutputSetupOnboardConfigureHelp,
}));

// mock-isolation: Exercise dispatch without constructing the real Commander program.
vi.mock("./program/build-program.js", () => ({ buildProgram: mocks.buildProgram }));
vi.mock("./program/program-context.js", () => ({ getProgramContext: mocks.getProgramContext }));
vi.mock("./program/command-registry-core.js", () => ({
  registerCoreCliByName: mocks.registerCoreCliByName,
}));
vi.mock("./program/register.subclis.js", () => ({
  registerSubCliByName: mocks.registerSubCliByName,
}));
vi.mock("../plugins/cli.js", () => ({
  registerPluginCliCommandsFromValidatedConfig: mocks.registerPluginCliCommandsFromValidatedConfig,
}));
vi.mock("../plugins/cli-registry-loader.js", () => ({
  loadPluginCliDescriptors: mocks.loadPluginCliDescriptors,
  createPluginCliLoadSession: mocks.createPluginCliLoadSession,
  resolvePluginCliRootOwnerIds: mocks.resolvePluginCliRootOwnerIds,
}));
vi.mock("../plugins/manifest-command-aliases.runtime.js", () => ({
  resolveManifestCliCommandSurfaceOwner: mocks.resolveManifestCliCommandSurfaceOwner,
  resolveManifestCommandAliasOwner: mocks.resolveManifestCommandAliasOwner,
  resolveManifestToolOwner: mocks.resolveManifestToolOwner,
}));
vi.mock("../runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime.js")>();
  return {
    ...actual,
    restoreRuntimeTerminalState: mocks.restoreRuntimeTerminalState,
  };
});
vi.mock("../infra/net/proxy-env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/net/proxy-env.js")>()),
  hasEnvHttpProxyAgentConfigured: mocks.hasEnvHttpProxyAgentConfigured,
}));
vi.mock("../infra/net/undici-global-dispatcher.js", () => ({
  ensureGlobalUndiciEnvProxyDispatcher: mocks.ensureGlobalUndiciEnvProxyDispatcher,
}));
vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

// mock-isolation: Dispatcher fixtures replace storage startup; real CLI tests cover selection.
vi.mock("./database-engine-selection.js", () => ({ prepareCliDatabaseEngine: async () => false }));

// mock-isolation: Gateway admission must read synthetic snapshots without real config I/O.
vi.mock("../config/io.factory.js", () => ({
  createConfigIO: (
    options: Parameters<typeof import("../config/io.factory.js").createConfigIO>[0] = {},
  ) => ({
    readConfigFileSnapshot: () =>
      mocks.readConfigFileSnapshot({
        isolateEnv: options.env !== undefined && options.env !== process.env,
        observe: options.observe,
        pluginValidation: options.pluginValidation,
      }),
    prepareConfigRecovery: async () => null,
  }),
}));

// mock-isolation: Bare-root routing uses fixture receipts rather than operator onboarding state.
vi.mock("../state/local-onboarding-state.js", () => ({
  readLocalOnboardingStateForConfigAsync: mocks.readLocalOnboardingState,
}));
vi.mock("../commands/onboard.js", () => ({ setupWizardCommand: mocks.setupWizardCommand }));
vi.mock("../commands/onboard-remote-gateway.js", () => ({
  runRemoteGatewayInferenceOnboarding: mocks.runRemoteGatewayInferenceOnboarding,
}));
vi.mock("../commands/onboard-helpers.js", () => ({
  probeGatewayConfiguredModel: mocks.probeGatewayConfiguredModel,
}));
vi.mock("../tui/tui.js", () => ({ runTui: mocks.runTui }));
vi.mock("./tui-cli.js", () => ({ runTuiCliAction: mocks.runTuiCliAction }));
vi.mock("./progress.js", () => ({ createCliProgress: mocks.createCliProgress }));
vi.mock("../config/io.js", () => ({
  readBestEffortConfig: mocks.loadConfig,
  readBestEffortConfigSnapshot: async (...args: Parameters<typeof mocks.loadConfig>) => ({
    config: mocks.loadConfig(...args),
  }),
  readSourceConfigBestEffort: mocks.readSourceConfigBestEffort,
}));
vi.mock("../infra/net/proxy/proxy-lifecycle.js", () => ({
  startProxy: mocks.startProxy,
  stopProxy: mocks.stopProxy,
}));

async function withCliExitSpies(
  run: (
    errorSpy: MockInstance<typeof console.error>,
    exitSpy: MockInstance<RuntimeEnv["exit"]>,
  ) => Promise<void>,
): Promise<void> {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const { defaultRuntime } = await import("../runtime.js");
  const exitSpy = vi.spyOn(defaultRuntime, "exit");
  try {
    await run(errorSpy, exitSpy);
  } finally {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  }
}

async function runGatewayBeforeHook(opts: { reset?: boolean } = {}): Promise<void> {
  await mocks.addGatewayRunCommand.mock.calls[0]?.[1]?.beforeRun?.(opts);
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

export const {
  tryRouteCli: tryRouteCliMock,
  loadDotEnv: loadDotEnvMock,
  existsSyncOverride,
  assertRuntime: assertRuntimeMock,
  isCurrentRuntimeSupported: isCurrentRuntimeSupportedMock,
  closeActiveMemorySearchManagers: closeActiveMemorySearchManagersMock,
  hasMemoryRuntime: hasMemoryRuntimeMock,
  listRegisteredAgentHarnesses: listRegisteredAgentHarnessesMock,
  disposeRegisteredAgentHarnesses: disposeRegisteredAgentHarnessesMock,
  hasProviderTransportDispatcherPool: hasProviderTransportDispatcherPoolMock,
  stopManagedProviderLocalServices: stopManagedProviderLocalServicesMock,
  closeProviderTransportDispatcherPool: closeProviderTransportDispatcherPoolMock,
  getActiveMcpLoopbackRuntime: getActiveMcpLoopbackRuntimeMock,
  closeMcpLoopbackServer: closeMcpLoopbackServerMock,
  outputRootHelp: outputRootHelpMock,
  outputPrecomputedRootHelpText: outputPrecomputedRootHelpTextMock,
  outputPrecomputedNodesHelpText: outputPrecomputedNodesHelpTextMock,
  loadRootHelpRenderOptionsForConfigSensitivePlugins:
    loadRootHelpRenderOptionsForConfigSensitivePluginsMock,
  tryOutputSetupOnboardConfigureHelp: tryOutputSetupOnboardConfigureHelpMock,
  buildProgram: buildProgramMock,
  parkCurrentLaunchAgentForMaintenance: parkCurrentLaunchAgentForMaintenanceMock,
  getProgramContext: getProgramContextMock,
  registerCoreCliByName: registerCoreCliByNameMock,
  registerSubCliByName: registerSubCliByNameMock,
  registerPluginCliCommandsFromValidatedConfig: registerPluginCliCommandsFromValidatedConfigMock,
  resolvePluginCliRootOwnerIds: resolvePluginCliRootOwnerIdsMock,
  createPluginCliLoadSession: createPluginCliLoadSessionMock,
  loadPluginCliDescriptors: loadPluginCliDescriptorsMock,
  resolveManifestCommandAliasOwner: resolveManifestCommandAliasOwnerMock,
  resolveManifestToolOwner: resolveManifestToolOwnerMock,
  restoreRuntimeTerminalState: restoreRuntimeTerminalStateMock,
  hasEnvHttpProxyAgentConfigured: hasEnvHttpProxyAgentConfiguredMock,
  ensureGlobalUndiciEnvProxyDispatcher: ensureGlobalUndiciEnvProxyDispatcherMock,
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  readLocalOnboardingState: readLocalOnboardingStateMock,
  setupWizardCommand: setupWizardCommandMock,
  runRemoteGatewayInferenceOnboarding: runRemoteGatewayInferenceOnboardingMock,
  runTui: runTuiMock,
  runTuiCliAction: runTuiCliActionMock,
  probeGatewayConfiguredModel: probeGatewayConfiguredModelMock,
  inspectGatewayTlsCertificate: inspectGatewayTlsCertificateMock,
  resolveControlUiLinks: resolveControlUiLinksMock,
  commanderParseAsync: commanderParseAsyncMock,
  addGatewayRunCommand: addGatewayRunCommandMock,
  ensureCliExecutionBootstrap: ensureCliExecutionBootstrapMock,
  emitCliBanner: emitCliBannerMock,
  enableConsoleCapture: enableConsoleCaptureMock,
  progressDone: progressDoneMock,
  createCliProgress: createCliProgressMock,
  loadConfig: loadConfigMock,
  readSourceConfigBestEffort: readSourceConfigBestEffortMock,
  startProxy: startProxyMock,
  stopProxy: stopProxyMock,
  flushExitAfterOneShotOutput: flushExitAfterOneShotOutputMock,
  requestExitAfterOneShotOutput: requestExitAfterOneShotOutputMock,
  maybeRunCliInContainer: maybeRunCliInContainerMock,
} = mocks;

export {
  cliArgs,
  readOnlyCoreOptions,
  tempDirs,
  runCli,
  withCliExitSpies,
  runGatewayBeforeHook,
  makeProgram,
  validConfig,
};

export function installRunMainTestHooks(): void {
  beforeAll(async () => {
    const runMainModule = await import("./run-main.js");
    expect(mocks.dotenvModuleImportState.count).toBe(0);
    runCli = runMainModule.runCli;
    startupConfig = await import("../commands/config-preflight-snapshot.js");
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
    mocks.existsSyncOverride.value = undefined;
    vi.clearAllMocks();
    mocks.resetDefaults();
    vi.spyOn(startupConfig, "readConfigSnapshotForEngineSelection").mockResolvedValue(
      createSnapshot({ hash: "fixture", sourceConfig: {} }),
    );
    mocks.readConfigFileSnapshot.mockResolvedValue(validConfig({ gateway: { mode: "local" } }));
    mocks.readLocalOnboardingState.mockReset().mockResolvedValue(undefined);
    mocks.probeGatewayConfiguredModel.mockResolvedValue({ kind: "configured" });
    mocks.readActiveGatewayLockPort.mockReset().mockResolvedValue(undefined);
    mocks.inspectGatewayTlsCertificate
      .mockReset()
      .mockResolvedValue({ ok: false, error: "gateway tls is disabled" });
    mocks.loadRootHelpRenderOptionsForConfigSensitivePlugins.mockResolvedValue(null);
    mocks.tryOutputSetupOnboardConfigureHelp.mockResolvedValue(true);
    mocks.loadConfig.mockReturnValue({});
    mocks.startProxy.mockResolvedValue(null);
    mocks.stopProxy.mockResolvedValue(undefined);
    mocks.loadPluginCliDescriptors.mockReset().mockResolvedValue([]);
    mocks.resolvePluginCliRootOwnerIds.mockImplementation(
      ({ primaryCommand }: { primaryCommand?: string }) =>
        primaryCommand === "googlemeet" ? ["google-meet"] : [],
    );
    mocks.resolveManifestCommandAliasOwner.mockReturnValue(undefined);
    mocks.resolveManifestToolOwner.mockReturnValue(undefined);
    mocks.resolveManifestCliCommandSurfaceOwner.mockReturnValue(undefined);
    delete process.env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH;
    delete process.env.OPENCLAW_HIDE_BANNER;
    loggingState.forceConsoleToStderr = false;
  });
}
