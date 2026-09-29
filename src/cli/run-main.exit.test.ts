// Run main exit tests cover process exit behavior for CLI failures.
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { CommanderError } from "commander";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ConfigSnapshotReadOptions } from "../config/io.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { GATEWAY_SERVICE_RUNTIME_PID_ENV } from "../daemon/constants.js";
import { createNewerSqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import { setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getPluginCache, type PluginCache } from "../plugins/plugin-cache.js";
import { withSecureTestNodeExecPath } from "../secrets/test-node-command.test-support.js";
import type { LocalOnboardingState } from "../state/local-onboarding-state.js";
import { captureEnv, withEnvAsync } from "../test-utils/env.js";
import { ExpectedCliError } from "./failure-output.js";
import { getGatewayRunRuntimeHooks } from "./gateway-cli/runtime-hooks.js";
import type { RootHelpRenderOptions } from "./program/root-help.js";
import { registerBareRootArgumentTests, withCliTty } from "./run-main.bare-root.test-support.js";
import {
  makeProxyHandle,
  registerRunMainProxyExitTests,
} from "./run-main.proxy-exit.test-support.js";
import { registerRunMainTimelineTests } from "./run-main.timeline.test-support.js";

const cliArgs = (...args: string[]) => ["node", "openclaw", ...args];

const readOnlyCoreOptions = { isolateEnv: true, observe: false, pluginValidation: "core-only" };

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const TLS_FINGERPRINT = "ab".repeat(32);
const PREFIXED_TLS_FINGERPRINT = `sha256:${TLS_FINGERPRINT.toUpperCase()}`;

type RunMainModule = typeof import("./run-main.js");

let runCli: RunMainModule["runCli"];

type ConfigSnapshotStub = {
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
const hasManagedProviderLocalServicesMock = vi.hoisted(() => vi.fn(() => false));
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
  hasManagedProviderLocalServices: hasManagedProviderLocalServicesMock,
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

function withInteractiveTty(fn: () => Promise<void>): Promise<void> {
  return withCliTty(true, fn);
}

function runBareCli(): Promise<void> {
  return withInteractiveTty(() => runCli(cliArgs()));
}

function expectBoundTui(expected: {
  url: string;
  configuredRemote?: boolean;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
}): void {
  expect(runTuiMock).toHaveBeenCalledWith(
    expect.objectContaining({
      deliver: false,
      forceProcessExitOnReturn: true,
      boundGateway: expected,
    }),
  );
}

function expectGatewayTarget(expected: Parameters<typeof expectBoundTui>[0]): void {
  expect(probeGatewayConfiguredModelMock).toHaveBeenCalledWith({
    ...expected,
    ...(expected.configuredRemote
      ? {
          originScopedDeviceAuth: true,
          config: expect.objectContaining({ gateway: expect.objectContaining({ mode: "remote" }) }),
        }
      : {}),
  });
  expectBoundTui(expected);
}

function validConfig(
  sourceConfig: ConfigSnapshotStub["sourceConfig"],
  overrides: Partial<Omit<ConfigSnapshotStub, "sourceConfig">> = {},
): ConfigSnapshotStub {
  return { exists: true, valid: true, sourceConfig, ...overrides };
}

function primeBareRootConfig(sourceConfig: ConfigSnapshotStub["sourceConfig"]): void {
  readConfigFileSnapshotMock.mockResolvedValueOnce({ exists: true, valid: true, sourceConfig });
}

async function expectNonInteractiveBareCliError(
  message: string,
  assert?: () => void,
): Promise<void> {
  const previousExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
  try {
    await withCliTty(false, () => runCli(cliArgs()));
    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(message);
    assert?.();
  } finally {
    errorSpy.mockRestore();
    process.exitCode = previousExitCode;
  }
}

async function withGatewayHome(
  files: (home: string) => Record<string, string>,
  run: (home: string) => Promise<void>,
): Promise<void> {
  const home = tempDirs.make("openclaw-run-main-env-");
  for (const [relative, content] of Object.entries(files(home))) {
    const target = path.join(home, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  await withEnvAsync(
    {
      HOME: home,
      OPENCLAW_HOME: home,
      OPENCLAW_STATE_DIR: undefined,
      OPENCLAW_CONFIG_PATH: undefined,
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: undefined,
      OPENCLAW_INCLUDE_ROOTS: undefined,
      NODE_OPTIONS: undefined,
    },
    () => run(home),
  );
}

describe("runCli exit behavior", () => {
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
    hasManagedProviderLocalServicesMock.mockReturnValue(false);
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

  it("carries one lightweight generation through builtin reads, nested registration and actions", async () => {
    const outside = getPluginCache();
    const phases: PluginCache[] = [];
    loadConfigMock.mockImplementationOnce(() => {
      phases.push(getPluginCache());
      return {};
    });
    registerSubCliByNameMock.mockImplementationOnce(async () => {
      await Promise.resolve();
      phases.push(getPluginCache());
    });
    const parseAsync = vi.fn(async () => {
      await Promise.resolve();
      phases.push(getPluginCache());
    });
    const program = makeProgram("plugins", parseAsync);
    buildProgramMock.mockReturnValueOnce(program).mockReturnValueOnce(program);
    tryRouteCliMock.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    await runCli(cliArgs("plugins", "late"));

    expect(phases).toHaveLength(3);
    const owner = phases[0]!;
    expect(owner.kind).toBe("operation");
    expect(phases.every((cache) => cache === owner)).toBe(true);
    expect(owner).not.toBe(outside);
    expect(getPluginCache()).toBe(outside);
    expect(createPluginCliLoadSessionMock).not.toHaveBeenCalled();
    expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();

    await runCli(cliArgs("plugins", "late"));
    expect(phases.at(-1)).not.toBe(owner);
    expect(getPluginCache()).toBe(outside);
  });

  it.each(["environment selection", "full Commander preaction"])(
    "parks the managed Gateway when a newer schema blocks %s",
    async (phase) => {
      const error = createNewerSqliteSchemaVersionError(
        "OpenClaw state database",
        "/tmp/openclaw-startup/state/openclaw.sqlite",
        14,
        13,
      );
      const argv = cliArgs("--log-level", "debug", "gateway", "run");
      if (phase === "environment selection") {
        readConfigFileSnapshotMock.mockRejectedValueOnce(error);
      } else {
        buildProgramMock.mockReturnValueOnce(
          makeProgram("gateway", vi.fn().mockRejectedValueOnce(error)),
        );
        tryRouteCliMock.mockResolvedValueOnce(false);
      }
      await withCliExitSpies(async (errorSpy, exitSpy) => {
        await expect(runCli(argv)).rejects.toThrow("exit:78");

        expect(parkCurrentLaunchAgentForMaintenanceMock).toHaveBeenCalledOnce();
        expect(exitSpy).toHaveBeenCalledWith(78);
        expect(errorSpy.mock.calls.flat().join("\n")).toContain(error.message);
        expect(addGatewayRunCommandMock).not.toHaveBeenCalled();
        if (phase === "environment selection") {
          expect(buildProgramMock).not.toHaveBeenCalled();
        } else {
          expect(buildProgramMock).toHaveBeenCalledOnce();
        }
      });
    },
  );

  it.each([
    { label: "Gateway help", args: ["gateway", "--help"] },
    { label: "another command", args: ["status"] },
  ])("does not park the Gateway for a newer-schema failure during $label", async ({ args }) => {
    const error = createNewerSqliteSchemaVersionError(
      "OpenClaw state database",
      "/tmp/openclaw-startup/state/openclaw.sqlite",
      14,
      13,
    );
    buildProgramMock.mockReturnValueOnce(
      makeProgram(args[0], vi.fn().mockRejectedValueOnce(error)),
    );

    await withEnvAsync({ OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH: "1" }, async () => {
      await expect(runCli(cliArgs(...args))).rejects.toBe(error);
    });

    expect(parkCurrentLaunchAgentForMaintenanceMock).not.toHaveBeenCalled();
  });

  it("completes asynchronous teardown before returning to the outer entrypoint", async () => {
    const order: string[] = [];
    listRegisteredAgentHarnessesMock.mockReturnValueOnce([{ harness: { id: "copilot" } }]);
    hasManagedProviderLocalServicesMock.mockReturnValueOnce(true);
    hasProviderTransportDispatcherPoolMock.mockReturnValueOnce(true);
    disposeRegisteredAgentHarnessesMock.mockImplementationOnce(async () => {
      order.push("harnesses");
    });
    stopManagedProviderLocalServicesMock.mockImplementationOnce(async () => {
      await Promise.resolve();
      order.push("provider-local-services");
    });
    closeProviderTransportDispatcherPoolMock.mockImplementationOnce(async () => {
      order.push("provider-transport-dispatchers");
    });
    getActiveMcpLoopbackRuntimeMock.mockReturnValueOnce({ port: 1234 });
    closeMcpLoopbackServerMock.mockImplementationOnce(async () => {
      order.push("mcp-loopback");
    });
    hasMemoryRuntimeMock.mockReturnValueOnce(true);
    closeActiveMemorySearchManagersMock.mockImplementationOnce(async () => {
      order.push("memory");
    });
    tryRouteCliMock.mockResolvedValueOnce(true);

    await runCli(cliArgs("models", "status", "--probe"));

    expect(order).toEqual([
      "harnesses",
      "provider-local-services",
      "provider-transport-dispatchers",
      "mcp-loopback",
      "memory",
    ]);
    expect(flushExitAfterOneShotOutputMock).not.toHaveBeenCalled();
  });

  it("defers config-drift exit until readiness releases its lease", async () => {
    readConfigFileSnapshotMock.mockResolvedValue(
      validConfig(
        {
          cron: { store: "/tmp/included-a.json" },
          gateway: { mode: "local" },
        },
        { hash: "guarded", path: "/tmp/openclaw.json", raw: "{}" },
      ),
    );
    await runCli(cliArgs("gateway"));
    await runGatewayBeforeHook();
    const beforeStatePreparation =
      ensureCliExecutionBootstrapMock.mock.calls[0]?.[0]?.beforeStatePreparation;
    readConfigFileSnapshotMock.mockResolvedValue(
      validConfig(
        {
          cron: { store: "/tmp/included-b.json" },
          gateway: { mode: "local" },
        },
        { hash: "guarded", path: "/tmp/openclaw.json", raw: "{}" },
      ),
    );
    await withCliExitSpies(async (errorSpy, exitSpy) => {
      await expect(beforeStatePreparation?.()).rejects.toMatchObject({
        name: "ExitError",
        code: 1,
      });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("changed during startup"));
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  it("defers a service-mode future-config exit to readiness", async () => {
    readConfigFileSnapshotMock.mockResolvedValue(
      validConfig(
        { gateway: { mode: "local" } },
        { hash: "guarded", path: "/tmp/openclaw.json", raw: "{}" },
      ),
    );
    await runCli(cliArgs("gateway"));
    await runGatewayBeforeHook();
    const beforeStatePreparation =
      ensureCliExecutionBootstrapMock.mock.calls[0]?.[0]?.beforeStatePreparation;
    await withCliExitSpies(async (errorSpy, exitSpy) => {
      await withEnvAsync(
        {
          OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: "1",
          OPENCLAW_SERVICE_MARKER: undefined,
        },
        async () => {
          await expect(
            beforeStatePreparation?.(
              validConfig(
                {
                  env: { vars: { OPENCLAW_SERVICE_MARKER: "gateway" } },
                  meta: { lastTouchedVersion: "9999.1.1" },
                },
                { hash: "future", path: "/tmp/openclaw.json", raw: "{}" },
              ),
            ),
          ).rejects.toMatchObject({ name: "ExitError", code: 78 });
          expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining("start the gateway service"),
          );
          expect(process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS).toBeUndefined();
          expect(exitSpy).not.toHaveBeenCalled();
        },
      );
    });
  });

  it.each([
    { flags: [], service: false, action: "run gateway state preparation", code: 1 },
    { flags: [], service: true, action: "start the gateway service", code: 78 },
    { flags: ["--force"], service: false, action: "force-kill gateway port listeners", code: 1 },
    { flags: ["--dev", "--reset"], service: false, action: "reset the dev gateway state", code: 1 },
  ])("blocks future config before $action", async ({ flags, service, action, code }) => {
    readConfigFileSnapshotMock.mockResolvedValue(
      validConfig({ meta: { lastTouchedVersion: "9999.1.1" } }),
    );
    await withEnvAsync(
      {
        OPENCLAW_SERVICE_MARKER: service ? "gateway" : undefined,
        OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: service ? "1" : undefined,
      },
      () =>
        withCliExitSpies(async (errorSpy) => {
          await expect(runCli(cliArgs("gateway", ...flags))).rejects.toThrow(`exit:${code}`);
          expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(action));
          expect(ensureCliExecutionBootstrapMock).not.toHaveBeenCalled();
          expect(readConfigFileSnapshotMock.mock.calls).toEqual([[readOnlyCoreOptions]]);
          expect(process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS).toBeUndefined();
        }),
    );
  });

  it("blocks and revokes the destructive override when selected config declares service mode", async () => {
    readConfigFileSnapshotMock.mockResolvedValue(
      validConfig({
        env: { vars: { OPENCLAW_SERVICE_MARKER: "gateway" } },
        meta: { lastTouchedVersion: "9999.1.1" },
      }),
    );
    await withCliExitSpies(async () => {
      await withEnvAsync(
        {
          OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: "1",
          OPENCLAW_SERVICE_MARKER: undefined,
        },
        async () => {
          await expect(runCli(cliArgs("gateway"))).rejects.toThrow("exit:78");
          expect(process.env.OPENCLAW_SERVICE_MARKER).toBeUndefined();
          expect(process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS).toBeUndefined();
          expect(ensureCliExecutionBootstrapMock).not.toHaveBeenCalled();
        },
      );
    });
  });

  it("loads state dotenv before a custom config-root fallback", async () => {
    await withGatewayHome(
      () => ({
        ".openclaw/.env": "OPENCLAW_GATEWAY_TOKEN=state-token\n",
        "profile/.env":
          "OPENCLAW_GATEWAY_PASSWORD=config-root-password\nOPENCLAW_GATEWAY_TOKEN=config-root-token\n",
      }),
      async (home) => {
        process.env.OPENCLAW_CONFIG_PATH = path.join(home, "profile", "openclaw.json");
        await runCli(cliArgs("gateway"));
        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("state-token");
        expect(process.env.OPENCLAW_GATEWAY_PASSWORD).toBe("config-root-password");
      },
    );
  });

  it("re-guards config selection from a newly selected state dotenv", async () => {
    await withGatewayHome(
      (home) => ({
        "state/.env": `OPENCLAW_CONFIG_PATH=${path.join(home, "state", "future.json")}\nOPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS=1\n`,
      }),
      async (home) => {
        const stateDir = path.join(home, "state");
        readConfigFileSnapshotMock.mockImplementation(async () =>
          validConfig(
            process.env.OPENCLAW_CONFIG_PATH === path.join(stateDir, "future.json")
              ? { meta: { lastTouchedVersion: "9999.1.1" } }
              : { env: { vars: { OPENCLAW_STATE_DIR: stateDir } }, gateway: { mode: "local" } },
          ),
        );
        await withCliExitSpies(async (errorSpy) => {
          await expect(runCli(cliArgs("gateway"))).rejects.toThrow("exit:1");
          expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining("run gateway state preparation"),
          );
          expect(ensureCliExecutionBootstrapMock).not.toHaveBeenCalled();
          expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(2);
          expect(process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS).toBeUndefined();
        });
      },
    );
  });

  it("does not apply environment variables from invalid config snapshots", async () => {
    await withEnvAsync({ OPENCLAW_INCLUDE_ROOTS: undefined }, async () => {
      readConfigFileSnapshotMock.mockResolvedValue({
        exists: true,
        issues: [{ message: "invalid", path: "gateway" }],
        legacyIssues: [],
        valid: false,
        sourceConfig: {
          env: { vars: { OPENCLAW_INCLUDE_ROOTS: "/tmp/openclaw-includes" } },
          gateway: { mode: "local" },
        },
      });

      await runCli(cliArgs("gateway"));
      await runGatewayBeforeHook();

      expect(process.env.OPENCLAW_INCLUDE_ROOTS).toBeUndefined();
      expect(readConfigFileSnapshotMock.mock.calls).toEqual([
        [readOnlyCoreOptions],
        [readOnlyCoreOptions],
      ]);
      expect(ensureCliExecutionBootstrapMock).toHaveBeenCalledWith(
        expect.objectContaining({
          commandPath: ["gateway"],
          beforeStatePreparation: expect.any(Function),
        }),
      );
    });
  });

  it("drops gateway.env selectors when the default state dotenv selects a custom state", async () => {
    await withGatewayHome(
      (home) => ({
        ".openclaw/.env": `OPENCLAW_STATE_DIR=${path.join(home, "selected-state")}\n`,
        ".config/openclaw/gateway.env":
          "OPENCLAW_CONFIG_PATH=/tmp/wrong-openclaw.json\nOPENCLAW_GATEWAY_TOKEN=fallback-token\n",
        "selected-state/.env":
          "OPENCLAW_GATEWAY_TOKEN=selected-token\nOPENCLAW_INCLUDE_ROOTS=/tmp/untrusted-include-root\nNODE_OPTIONS=--require /tmp/untrusted.js\n",
      }),
      async (home) => {
        await runCli(cliArgs("gateway"));
        expect(process.env.OPENCLAW_STATE_DIR).toBe(path.join(home, "selected-state"));
        expect(process.env.OPENCLAW_CONFIG_PATH).toBeUndefined();
        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("selected-token");
      },
    );
  });

  it("preserves gateway.env selectors when the compatibility fallback selects the target", async () => {
    await withGatewayHome(
      (home) => ({
        ".config/openclaw/gateway.env": `OPENCLAW_STATE_DIR=${path.join(home, "selected-state")}\nOPENCLAW_GATEWAY_TOKEN=fallback-token\n`,
        "selected-state/.env": "OPENCLAW_GATEWAY_TOKEN=selected-token\n",
      }),
      async (home) => {
        await runCli(cliArgs("gateway"));
        expect(process.env.OPENCLAW_STATE_DIR).toBe(path.join(home, "selected-state"));
        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("selected-token");
        expect(process.env.OPENCLAW_INCLUDE_ROOTS).toBeUndefined();
        expect(process.env.NODE_OPTIONS).toBeUndefined();
      },
    );
  });

  it("drops early target credentials when a later guard selects another state", async () => {
    await withGatewayHome(
      () => ({
        ".openclaw/.env": "OPENCLAW_GATEWAY_TOKEN=early-token\n",
        "selected-state/.env": "OPENCLAW_GATEWAY_TOKEN=selected-token\n",
      }),
      async (home) => {
        const selectedStateDir = path.join(home, "selected-state");
        let selectLateState = false;
        readConfigFileSnapshotMock.mockImplementation(async () =>
          validConfig(
            selectLateState && process.env.OPENCLAW_STATE_DIR !== selectedStateDir
              ? {
                  env: { vars: { OPENCLAW_STATE_DIR: selectedStateDir } },
                  gateway: { mode: "local" },
                }
              : { gateway: { mode: "local" } },
          ),
        );
        await runCli(cliArgs("gateway"));
        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("early-token");
        selectLateState = true;
        await runGatewayBeforeHook();
        expect(process.env.OPENCLAW_STATE_DIR).toBe(selectedStateDir);
        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("selected-token");
        expect(ensureCliExecutionBootstrapMock).toHaveBeenCalledOnce();
      },
    );
  });

  it("retains selected config paths and invocation reset targets", async () => {
    await withEnvAsync(
      {
        OPENCLAW_CONFIG_PATH: "/tmp/openclaw-invocation/openclaw.json",
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_HOME: "/tmp/openclaw-invocation-home",
        OPENCLAW_INCLUDE_ROOTS: undefined,
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_STATE_DIR: "/tmp/openclaw-invocation-state",
        OPENCLAW_TEST_FAST: "1",
        OPENCLAW_WORKSPACE_DIR: "/tmp/openclaw-invocation-workspace",
      },
      async () => {
        readConfigFileSnapshotMock.mockResolvedValue(
          validConfig({
            env: {
              vars: {
                OPENCLAW_CONFIG_PATH: "/tmp/openclaw-reset/openclaw.json",
                OPENCLAW_GATEWAY_TOKEN: "old-token",
                OPENCLAW_HOME: "/tmp/openclaw-reset-home",
                OPENCLAW_INCLUDE_ROOTS: "/tmp/openclaw-reset-includes",
                OPENCLAW_PROFILE: "config-dev",
                OPENCLAW_STATE_DIR: "/tmp/openclaw-reset",
                OPENCLAW_TEST_FAST: "0",
                OPENCLAW_WORKSPACE_DIR: "/tmp/openclaw-reset-workspace",
              },
            },
            gateway: { mode: "local" },
          }),
        );
        await runCli(cliArgs("gateway", "--dev", "--reset"));

        await runGatewayBeforeHook({ reset: true });

        expect(process.env.OPENCLAW_CONFIG_PATH).toBe("/tmp/openclaw-invocation/openclaw.json");
        expect(process.env.OPENCLAW_HOME).toBe("/tmp/openclaw-invocation-home");
        expect(process.env.OPENCLAW_PROFILE).toBeUndefined();
        expect(process.env.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-invocation-state");
        expect(process.env.OPENCLAW_TEST_FAST).toBe("1");
        expect(process.env.OPENCLAW_WORKSPACE_DIR).toBe("/tmp/openclaw-invocation-workspace");
        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
        expect(process.env.OPENCLAW_INCLUDE_ROOTS).toBeUndefined();
        expect(ensureCliExecutionBootstrapMock).not.toHaveBeenCalled();
      },
    );
  });

  it("honors banner suppression on the gateway foreground fast path", async () => {
    process.env.OPENCLAW_HIDE_BANNER = "1";

    await runCli(cliArgs("gateway"));

    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(emitCliBannerMock).not.toHaveBeenCalled();
    expect(commanderParseAsyncMock).toHaveBeenCalledWith(cliArgs("gateway"));
  });

  it("renders nodes help from startup metadata without building the full program", async () => {
    outputPrecomputedNodesHelpTextMock.mockReturnValueOnce(true);

    await runCli(cliArgs("nodes", "--help"));

    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(outputPrecomputedNodesHelpTextMock).toHaveBeenCalledTimes(1);
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(registerSubCliByNameMock).not.toHaveBeenCalled();
  });

  it("defers nodes help startup metadata when plugin config can change command metadata", async () => {
    const argv = cliArgs("nodes", "--help");
    const parseAsync = vi.fn().mockResolvedValueOnce(undefined);
    const program = makeProgram("nodes", parseAsync);
    loadRootHelpRenderOptionsForConfigSensitivePluginsMock.mockResolvedValueOnce({ env: {} });
    outputPrecomputedNodesHelpTextMock.mockReturnValueOnce(true);
    buildProgramMock.mockReturnValueOnce(program);

    await runCli(argv);

    expect(loadRootHelpRenderOptionsForConfigSensitivePluginsMock).toHaveBeenCalledTimes(1);
    expect(outputPrecomputedNodesHelpTextMock).not.toHaveBeenCalled();
    expect(registerSubCliByNameMock.mock.calls).toEqual([[program, "nodes", argv]]);
    expect(parseAsync).toHaveBeenCalledWith(argv);
  });

  it("renders selected subcommand help from startup metadata without building the full program", async () => {
    outputPrecomputedSubcommandHelpTextMock.mockReturnValueOnce(true);

    await runCli(cliArgs("doctor", "--help"));

    expect(outputPrecomputedSubcommandHelpTextMock).toHaveBeenCalledWith("doctor");
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(closeActiveMemorySearchManagersMock).not.toHaveBeenCalled();
  });

  it("keeps root help on the precomputed path without proxy bootstrap", async () => {
    outputPrecomputedRootHelpTextMock.mockReturnValueOnce(true);

    await runCli(cliArgs("--help"));

    expect(loadRootHelpRenderOptionsForConfigSensitivePluginsMock).toHaveBeenCalledTimes(1);
    expect(outputPrecomputedRootHelpTextMock).toHaveBeenCalledTimes(1);
    expect(hasEnvHttpProxyAgentConfiguredMock).not.toHaveBeenCalled();
    expect(ensureGlobalUndiciEnvProxyDispatcherMock).not.toHaveBeenCalled();
  });

  it("renders setup/onboard/configure help without building the full program", async () => {
    await runCli(cliArgs("setup", "--help"));

    expect(tryOutputSetupOnboardConfigureHelpMock).toHaveBeenCalledWith(cliArgs("setup", "--help"));
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
  });

  it("renders root help without building the full program", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${String(code)})`);
    }) as typeof process.exit);

    await runCli(cliArgs("--help"));

    expect(maybeRunCliInContainerMock).toHaveBeenCalledWith(cliArgs("--help"));
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(loadRootHelpRenderOptionsForConfigSensitivePluginsMock).toHaveBeenCalledTimes(1);
    expect(outputPrecomputedRootHelpTextMock).toHaveBeenCalledTimes(1);
    expect(outputRootHelpMock).toHaveBeenCalledTimes(1);
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(closeActiveMemorySearchManagersMock).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("renders config-sensitive root help live instead of precomputed metadata", async () => {
    const liveOptions: RootHelpRenderOptions = {
      config: {
        plugins: {
          slots: { memory: "memory-lancedb" },
        },
      },
      env: process.env,
    };
    loadRootHelpRenderOptionsForConfigSensitivePluginsMock.mockResolvedValueOnce(liveOptions);
    outputPrecomputedRootHelpTextMock.mockReturnValueOnce(true);

    await runCli(cliArgs("--help"));

    expect(loadRootHelpRenderOptionsForConfigSensitivePluginsMock).toHaveBeenCalledTimes(1);
    expect(outputPrecomputedRootHelpTextMock).not.toHaveBeenCalled();
    expect(outputRootHelpMock).toHaveBeenCalledWith(liveOptions);
    expect(buildProgramMock).not.toHaveBeenCalled();
  });

  it("awaits runtime support before choosing source-only proxy config", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);
    isCurrentRuntimeSupportedMock.mockResolvedValueOnce(false);
    readSourceConfigBestEffortMock.mockResolvedValueOnce({
      proxy: { proxyUrl: "http://source.invalid" },
    });
    await runCli(cliArgs("plugins", "marketplace", "list"));
    expect(readSourceConfigBestEffortMock).toHaveBeenCalledOnce();
    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(startProxyMock).toHaveBeenCalledWith({ proxyUrl: "http://source.invalid" });
  });

  registerRunMainTimelineTests({
    runCli: (argv) => runCli(argv),
    loadConfigMock,
    readSourceConfigBestEffortMock,
    tryRouteCliMock,
  });

  it.each([["root shorthand", cliArgs("--update", "--dry-run", "--json")]])(
    "reads source-only proxy config for the update dry-run %s",
    async (_name, argv) => {
      tryRouteCliMock.mockResolvedValueOnce(true);
      readSourceConfigBestEffortMock.mockResolvedValueOnce({ proxy: { selected: "dry-run" } });

      await runCli(argv);

      expect(readSourceConfigBestEffortMock).toHaveBeenCalledOnce();
      expect(loadConfigMock).not.toHaveBeenCalled();
      expect(startProxyMock).toHaveBeenCalledWith({ selected: "dry-run" });
    },
  );

  it.each([["lint", ["--lint", "--json"]]])(
    "reads source-only proxy config before Doctor %s owns state access",
    async (_mode, args) => {
      tryRouteCliMock.mockResolvedValueOnce(true);
      readSourceConfigBestEffortMock.mockResolvedValueOnce({ proxy: { selected: "doctor" } });
      loadConfigMock.mockImplementation(() => {
        throw new Error("Shared state requires Doctor repair");
      });

      await runCli(cliArgs("doctor", ...args));

      expect(readSourceConfigBestEffortMock).toHaveBeenCalledOnce();
      expect(loadConfigMock).not.toHaveBeenCalled();
      expect(startProxyMock).toHaveBeenCalledWith({ selected: "doctor" });
    },
  );

  it.each([
    {
      name: "profiled version-pinned skill verification",
      argv: cliArgs(
        "--profile",
        "work",
        "skills",
        "verify",
        "@owner/weather",
        "--version",
        "1.2.3",
      ),
    },
  ])("starts the managed proxy for $name", async ({ argv }) => {
    await withEnvAsync(
      {
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_STATE_DIR: undefined,
        OPENCLAW_CONFIG_PATH: undefined,
      },
      async () => {
        hasEnvHttpProxyAgentConfiguredMock.mockReturnValue(true);
        tryRouteCliMock.mockResolvedValueOnce(true);

        await runCli(argv);

        expect(startProxyMock).toHaveBeenCalledWith(undefined);
        expect(ensureGlobalUndiciEnvProxyDispatcherMock).toHaveBeenCalledOnce();
      },
    );
  });

  it.each([
    ["cron parent timeout", cliArgs("cron", "--timeout", "250", "status")],
    ["cron scratch equals", cliArgs("cron", "scratch", "job", "--set=text")],
    ["gateway handoff", cliArgs("gateway", "--port", "18789", "restart-handoff", "capabilities")],
    ["node invoke", cliArgs("nodes", "invoke", "--node", "one")],
    ["device token", cliArgs("devices", "rotate", "--device", "one")],
    ["doctor lint", cliArgs("doctor", "--lint")],
    ["proxy coverage", cliArgs("proxy", "coverage")],
  ])("routes startup diagnostics for default-machine %s output", async (_name, argv) => {
    tryRouteCliMock.mockImplementationOnce(async () => {
      expect(loggingState.forceConsoleToStderr).toBe(true);
      return true;
    });

    await runCli(argv);

    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("routes managed-proxy startup logs for plugin-declared machine output", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);
    let observedStdoutIsTTY: boolean | undefined;
    resolvePluginCliRootOwnerIdsMock.mockImplementation(
      ({ primaryCommand }: { primaryCommand?: string }) =>
        primaryCommand === "path" ? ["oc-path"] : [],
    );
    loadPluginCliDescriptorsMock.mockResolvedValueOnce([
      {
        name: "path",
        description: "OC path",
        hasSubcommands: true,
        machineOutput: ({ stdoutIsTTY }: { stdoutIsTTY: boolean }) => {
          observedStdoutIsTTY = stdoutIsTTY;
          return !stdoutIsTTY;
        },
      },
    ]);
    startProxyMock.mockImplementationOnce(async () => {
      expect(loggingState.forceConsoleToStderr).toBe(true);
      return null;
    });

    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: undefined });
    try {
      await runCli(cliArgs("path", "validate", "oc://AGENTS.md"));
    } finally {
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      } else {
        Reflect.deleteProperty(process.stdout, "isTTY");
      }
    }

    expect(startProxyMock).toHaveBeenCalledWith(undefined);
    expect(observedStdoutIsTTY).toBe(false);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it.each([
    ["full Commander path with root options", cliArgs("--log-level", "debug", "gateway", "run")],
  ])("isolates %s gateway proxy config reads core-only", async (_name, argv) => {
    existsSyncOverride.value = (target) => target === path.join(process.cwd(), ".env");
    if (_name === "full Commander path with root options") {
      tryRouteCliMock.mockResolvedValueOnce(false);
      buildProgramMock.mockReturnValueOnce(makeProgram("gateway", commanderParseAsyncMock));
    }
    await runCli(argv);

    expect(loadDotEnvMock).toHaveBeenCalledWith({ loadGlobalEnv: false, quiet: true });
    if (_name === "full Commander path with root options") {
      expect(buildProgramMock).toHaveBeenCalledTimes(1);
      expect(commanderParseAsyncMock).toHaveBeenLastCalledWith(argv);
    }
    expect(loadConfigMock).toHaveBeenCalledWith(readOnlyCoreOptions);
    expect(startProxyMock).toHaveBeenCalledWith(undefined);
  });

  it("keeps explicit database preflight isolated from default state selection", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);

    await runCli(cliArgs("database", "preflight", "/tmp/openclaw-candidate.sqlite", "--json"));

    expect(loadDotEnvMock).not.toHaveBeenCalled();
    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(startProxyMock).not.toHaveBeenCalled();
  });

  it("stops before config selection when asynchronous runtime validation rejects", async () => {
    const error = new Error("unsupported runtime");
    const validation = Promise.reject(error);
    // The regression must also join this rejection when old code ignores the returned promise.
    void validation.catch(() => {});
    assertRuntimeMock.mockReturnValueOnce(validation);

    await expect(runCli(cliArgs("gateway", "run"))).rejects.toBe(error);
    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
  });

  it("replaces the early managed proxy with the final accepted gateway config", async () => {
    const earlyHandle = makeProxyHandle();
    const finalHandle = makeProxyHandle();
    const earlyProxy = { proxyUrl: "http://127.0.0.1:19876" };
    const finalProxy = { proxyUrl: "http://127.0.0.1:29876" };
    loadConfigMock.mockReturnValueOnce({ proxy: earlyProxy });
    startProxyMock.mockResolvedValueOnce(earlyHandle).mockResolvedValueOnce(finalHandle);
    commanderParseAsyncMock.mockImplementationOnce(async () => {
      await runGatewayBeforeHook();
      await getGatewayRunRuntimeHooks().refreshManagedProxy?.(finalProxy);
    });

    await runCli(cliArgs("gateway", "run"));

    expect(startProxyMock).toHaveBeenNthCalledWith(1, earlyProxy);
    expect(startProxyMock).toHaveBeenNthCalledWith(2, finalProxy);
    expect(stopProxyMock).toHaveBeenNthCalledWith(1, earlyHandle);
    expect(stopProxyMock).toHaveBeenNthCalledWith(2, finalHandle);
    const earlyStopOrder = stopProxyMock.mock.invocationCallOrder[0] ?? 0;
    const finalEnvironmentReadOrder = readConfigFileSnapshotMock.mock.invocationCallOrder[1] ?? 0;
    const finalStartOrder = startProxyMock.mock.invocationCallOrder[1] ?? 0;
    expect(finalEnvironmentReadOrder).toBeGreaterThan(earlyStopOrder);
    expect(finalStartOrder).toBeGreaterThan(earlyStopOrder);
  });

  it("removes early proxy signal handlers when the final config disables the proxy", async () => {
    const earlyHandle = makeProxyHandle();
    const earlyProxy = { proxyUrl: "http://127.0.0.1:19876" };
    const finalProxy = undefined;
    loadConfigMock.mockReturnValueOnce({ proxy: earlyProxy });
    startProxyMock.mockResolvedValueOnce(earlyHandle).mockResolvedValueOnce(null);
    const processOnceSpy = vi.spyOn(process, "once");
    const processOffSpy = vi.spyOn(process, "off");
    commanderParseAsyncMock.mockImplementationOnce(async () => {
      const sigtermHandler = processOnceSpy.mock.calls.find(([event]) => event === "SIGTERM")?.[1];
      const sigintHandler = processOnceSpy.mock.calls.find(([event]) => event === "SIGINT")?.[1];
      const exitHandler = processOnceSpy.mock.calls.find(([event]) => event === "exit")?.[1];

      await getGatewayRunRuntimeHooks().refreshManagedProxy?.(finalProxy);

      expect(processOffSpy).toHaveBeenCalledWith("SIGTERM", sigtermHandler);
      expect(processOffSpy).toHaveBeenCalledWith("SIGINT", sigintHandler);
      expect(processOffSpy).toHaveBeenCalledWith("exit", exitHandler);
    });

    try {
      await runCli(cliArgs("gateway", "run"));
    } finally {
      processOffSpy.mockRestore();
      processOnceSpy.mockRestore();
    }

    expect(startProxyMock).toHaveBeenNthCalledWith(1, earlyProxy);
    expect(startProxyMock).toHaveBeenNthCalledWith(2, finalProxy);
    expect(stopProxyMock).toHaveBeenCalledOnce();
    expect(stopProxyMock).toHaveBeenCalledWith(earlyHandle);
  });

  it("leaves plugin-owned URL arguments on the plugin command path", async () => {
    const target = "https://gateway.example/dashboard/main/movies-a1166b81";
    const argv = cliArgs("googlemeet", target);
    buildProgramMock.mockReturnValueOnce({ commands: [], parseAsync: commanderParseAsyncMock });

    await runCli(argv);

    expect(runTuiCliActionMock).not.toHaveBeenCalled();
    expect(buildProgramMock).toHaveBeenCalledTimes(1);
    expect(commanderParseAsyncMock).toHaveBeenCalledWith(argv);
  });

  it.each([
    {
      label: "before the URL with split values",
      args: [
        "--token",
        "direct-token",
        "--password",
        "direct-password",
        "--tls-fingerprint",
        PREFIXED_TLS_FINGERPRINT,
        "https://gateway.example/dashboard/main/movies-a1166b81",
        "--deliver",
        "--message",
        "continue here",
      ],
    },
    {
      label: "before the URL with inline values",
      args: [
        "--token=direct-token",
        "--password=direct-password",
        `--tls-fingerprint=${PREFIXED_TLS_FINGERPRINT}`,
        "--message=continue here",
        "https://gateway.example/dashboard/main/movies-a1166b81",
        "--deliver",
      ],
    },
  ])("forwards bare-root TUI options $label without an environment handoff", async ({ args }) => {
    const target = "https://gateway.example/dashboard/main/movies-a1166b81";
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: "ambient-token",
        OPENCLAW_GATEWAY_PASSWORD: "ambient-password",
      },
      () => withInteractiveTty(() => runCli(cliArgs(...args))),
    );

    expect(runTuiCliActionMock).toHaveBeenCalledWith(target, {
      token: "direct-token",
      password: "direct-password",
      tlsFingerprint: PREFIXED_TLS_FINGERPRINT,
      deliver: true,
      message: "continue here",
    });
  });

  it.each([
    ["unknown inline option", ["--typo=do-not-print-me"]],
    ["option terminator", ["--"]],
  ])("rejects a pre-URL %s without reflecting values", async (_label, prefix) => {
    const target = "https://gateway.example/dashboard/main/movies-a1166b81";
    let error: unknown;
    try {
      await runCli(cliArgs(...prefix, target));
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("do-not-print-me");
    expect(runTuiCliActionMock).not.toHaveBeenCalled();
  });

  it("rejects a missing pre-URL direct option value before command discovery", async () => {
    const target = "https://gateway.example/dashboard/main/movies-a1166b81";

    await expect(runCli(cliArgs("--token", target))).rejects.toThrow("--token requires a value");
    expect(runTuiCliActionMock).not.toHaveBeenCalled();
  });

  it("suggests close known commands for unowned command roots before proxy startup", async () => {
    const error = await runCli(cliArgs("upate")).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ExpectedCliError);
    expect((error as ExpectedCliError).humanOutput).toContain(
      "Did you mean this?\n  openclaw update\n",
    );

    expect(startProxyMock).not.toHaveBeenCalled();
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
  });

  it("sanitizes control characters in unowned command diagnostics", async () => {
    const primary = "bad\u001b[31m-red\u001b[0m\nforged\tline";

    await expect(runCli(cliArgs(primary))).rejects.toThrow(
      'OpenClaw does not know the command "bad-red\\nforged\\tline".',
    );

    expect(startProxyMock).not.toHaveBeenCalled();
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
  });

  it("bounds long unowned command diagnostics without splitting Unicode", async () => {
    const primary = "🦞".repeat(1_000);

    let error: unknown;
    try {
      await runCli(cliArgs(primary));
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    const displayPrimary = `${"🦞".repeat(63)}…`;
    expect(displayPrimary.length).toBeLessThanOrEqual(128);
    expect(message).toContain(`OpenClaw does not know the command "${displayPrimary}".`);
    expect(message).not.toContain("�");
    expect(message.length).toBeLessThan(500);
    expect(startProxyMock).not.toHaveBeenCalled();
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "plugins.allow exclusion",
      command: "workboard",
      config: { plugins: { allow: ["browser"] } },
      commandAlias: { pluginId: "workboard" },
      expectedText: '`plugins.allow` excludes "workboard"',
    },
    {
      label: "parent plugin allowlist guidance",
      command: "voicecall",
      config: { plugins: { allow: ["voicecall"] } },
      commandAlias: { pluginId: "voice-call" },
      expectedText: 'Add "voice-call" to `plugins.allow` instead of "voicecall"',
    },
    {
      label: "explicit plugin disablement",
      command: "browser",
      config: { plugins: { entries: { browser: { enabled: false } } } },
      commandAlias: { pluginId: "browser", enabledByDefault: true },
      expectedText: "plugins.entries.browser.enabled=false",
    },
    {
      label: "runtime slash command",
      command: "dreaming",
      config: {},
      commandAlias: { pluginId: "memory-core", kind: "runtime-slash", cliCommand: "memory" },
      expectedText: "runtime slash command (/dreaming)",
    },
    {
      label: "loaded agent tool",
      command: "lcm_recent",
      config: {},
      toolOwner: { toolName: "lcm_recent", pluginId: "lossless-claw", availability: "loaded" },
      expectedText: "is an agent tool available",
    },
    {
      label: "manifest-only agent tool",
      command: "feishu_chat",
      config: {},
      toolOwner: { toolName: "feishu_chat", pluginId: "feishu", availability: "manifest-only" },
      expectedText: "may be provided",
    },
  ])(
    "reports $label as an expected condition before proxy startup",
    async ({ command, config, commandAlias, toolOwner, expectedText }) => {
      loadConfigMock.mockReturnValue(config);
      resolveManifestCommandAliasOwnerMock.mockReturnValue(commandAlias);
      resolveManifestToolOwnerMock.mockReturnValue(toolOwner);

      const error = await runCli(cliArgs(command)).catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(ExpectedCliError);
      expect((error as ExpectedCliError).message).toContain(expectedText);
      expect((error as ExpectedCliError).humanOutput).toBe((error as Error).message);
      expect((error as ExpectedCliError).machineOutput).toBe((error as Error).message);
      expect((error as Error).message).not.toContain("Did you mean this?");
      expect(startProxyMock).not.toHaveBeenCalled();
      expect(tryRouteCliMock).not.toHaveBeenCalled();
      expect(buildProgramMock).not.toHaveBeenCalled();
      expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
    },
  );

  it("reports disabled-by-default plugin commands as expected after lazy registration", async () => {
    const program = { commands: [], parseAsync: vi.fn() };
    buildProgramMock.mockReturnValueOnce(program);
    tryRouteCliMock.mockResolvedValueOnce(false);
    resolvePluginCliRootOwnerIdsMock.mockReturnValue(["workboard"]);
    resolveManifestCommandAliasOwnerMock.mockReturnValue({
      pluginId: "workboard",
      enabledByDefault: false,
    });

    const error = await runCli(cliArgs("workboard", "list")).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ExpectedCliError);
    expect((error as ExpectedCliError).message).toContain(
      'the "workboard" plugin, but that bundled plugin is disabled by default',
    );
    expect((error as ExpectedCliError).humanOutput).toBe((error as Error).message);
    expect((error as ExpectedCliError).machineOutput).toBe((error as Error).message);
    expect(registerPluginCliCommandsFromValidatedConfigMock).toHaveBeenCalledWith(
      program,
      undefined,
      undefined,
      {
        mode: "lazy",
        primary: "workboard",
        skipPluginValidation: false,
        session: createPluginCliLoadSessionMock.mock.results.at(-1)?.value,
      },
    );
    expect(program.parseAsync).not.toHaveBeenCalled();
  });

  it("rejects unowned command roots even when --help is appended (regression for #81077)", async () => {
    await expect(runCli(cliArgs("foo", "--help"))).rejects.toThrow(
      'OpenClaw does not know the command "foo".',
    );

    expect(startProxyMock).not.toHaveBeenCalled();
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
  });

  it("preserves plugins.allow diagnostics for roots owned only by CLI metadata", async () => {
    loadConfigMock.mockReturnValueOnce({
      plugins: { allow: ["browser"] },
    });
    resolvePluginCliRootOwnerIdsMock.mockImplementation(
      ({
        cfg,
        primaryCommand,
      }: {
        cfg?: { plugins?: { allow?: string[] } };
        primaryCommand?: string;
      }) => (primaryCommand === "qa" && cfg?.plugins?.allow?.length === 0 ? ["qa-lab"] : []),
    );

    await expect(runCli(cliArgs("qa"))).rejects.toThrow(
      'Add "qa-lab" to `plugins.allow` instead of "qa"',
    );
    expect(startProxyMock).not.toHaveBeenCalled();
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
  });

  it.each([["auth", cliArgs("auth", "--help")]])(
    "keeps reserved %s command roots out of plugin command discovery",
    async (_name, argv) => {
      const parseAsync = vi.fn().mockResolvedValueOnce(undefined);
      const program = { commands: [], parseAsync };
      buildProgramMock.mockReturnValueOnce(program);

      await runCli(argv);

      expect(startProxyMock).not.toHaveBeenCalled();
      expect(registerSubCliByNameMock.mock.calls).toEqual([[program, argv[2], argv]]);
      expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
      expect(parseAsync).toHaveBeenCalledWith(argv);
    },
  );

  it("routes incidental logs to stderr throughout --json startup and dispatch", async () => {
    tryRouteCliMock.mockResolvedValueOnce(false);
    resolvePluginCliRootOwnerIdsMock.mockImplementation(
      ({ primaryCommand }: { primaryCommand?: string }) =>
        primaryCommand === "memory" ? ["memory"] : [],
    );
    let stderrDuringPluginRegistration = false;
    let stderrDuringParse = true;
    registerPluginCliCommandsFromValidatedConfigMock.mockImplementationOnce(async () => {
      stderrDuringPluginRegistration = loggingState.forceConsoleToStderr;
      return {};
    });
    const parseAsync = vi.fn().mockImplementationOnce(async () => {
      stderrDuringParse = loggingState.forceConsoleToStderr;
    });
    buildProgramMock.mockReturnValueOnce({ commands: [], parseAsync });

    await runCli(cliArgs("memory", "search", "query", "--json"));

    expect(registerPluginCliCommandsFromValidatedConfigMock).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      undefined,
      {
        mode: "lazy",
        primary: "memory",
        skipPluginValidation: true,
        session: createPluginCliLoadSessionMock.mock.results.at(-1)?.value,
      },
    );
    expect(stderrDuringPluginRegistration).toBe(true);
    expect(stderrDuringParse).toBe(true);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("retains stderr routing for late subsystem logs in one-shot JSON commands", async () => {
    tryRouteCliMock.mockResolvedValueOnce(false);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const previousRawConsole = loggingState.rawConsole;
    const previousOverrideSettings = loggingState.overrideSettings as Parameters<
      typeof setLoggerOverride
    >[0];
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(((
      value: string | Uint8Array,
    ) => {
      stdout.push(String(value));
      return true;
    }) as typeof process.stdout.write);
    setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle: "compact" });
    loggingState.rawConsole = {
      log: (value) => stdout.push(String(value)),
      info: (value) => stdout.push(String(value)),
      warn: (value) => stderr.push(String(value)),
      error: (value) => stderr.push(String(value)),
    };
    buildProgramMock.mockReturnValueOnce({
      commands: [],
      parseAsync: vi.fn(async () => {
        process.stdout.write('{"ok":true,"status":"ok"}\n');
      }),
    });

    try {
      await runCli(cliArgs("agent", "exec", "inspect", "--json"), {
        retainConsoleRoutingUntilProcessExit: true,
      });
      createSubsystemLogger("state/db").info("late migration diagnostic");

      expect(JSON.parse(stdout.join(""))).toEqual({ ok: true, status: "ok" });
      expect(stderr).toEqual([expect.stringContaining("late migration diagnostic")]);
      expect(loggingState.forceConsoleToStderr).toBe(true);
    } finally {
      stdoutWrite.mockRestore();
      loggingState.rawConsole = previousRawConsole;
      setLoggerOverride(previousOverrideSettings);
      loggingState.forceConsoleToStderr = false;
      loggingState.earlyConsoleRoutingRestore = null;
    }
  });

  it("does not route lazy plugin registration logs for pass-through --json after terminator", async () => {
    tryRouteCliMock.mockResolvedValueOnce(false);
    resolvePluginCliRootOwnerIdsMock.mockImplementation(
      ({ primaryCommand }: { primaryCommand?: string }) =>
        primaryCommand === "memory" ? ["memory"] : [],
    );
    let stderrDuringPluginRegistration = true;
    registerPluginCliCommandsFromValidatedConfigMock.mockImplementationOnce(async () => {
      stderrDuringPluginRegistration = loggingState.forceConsoleToStderr;
      return {};
    });
    const parseAsync = vi.fn().mockResolvedValueOnce(undefined);
    buildProgramMock.mockReturnValueOnce({ commands: [], parseAsync });

    await runCli(cliArgs("memory", "--", "--json"));

    expect(registerPluginCliCommandsFromValidatedConfigMock).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      undefined,
      {
        mode: "lazy",
        primary: "memory",
        skipPluginValidation: false,
        session: createPluginCliLoadSessionMock.mock.results.at(-1)?.value,
      },
    );
    const session = createPluginCliLoadSessionMock.mock.results.at(-1)?.value;
    expect(session?.close.mock.invocationCallOrder[0]).toBeLessThan(
      parseAsync.mock.invocationCallOrder[0]!,
    );
    expect(stderrDuringPluginRegistration).toBe(false);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  registerRunMainProxyExitTests({
    runCli: (argv) => runCli(argv),
    startProxyMock,
    stopProxyMock,
    tryRouteCliMock,
  });

  it.each([
    {
      name: "resumes onboarding when an interrupted first run only persisted risk acknowledgement",
      snapshot: validConfig({
        meta: { updatedBy: "fixture" },
        wizard: { securityAcknowledgedAt: "2026-07-13T00:00:00.000Z" },
      }),
    },
  ])("$name", async ({ snapshot }) => {
    readConfigFileSnapshotMock.mockResolvedValueOnce(snapshot);
    await expect(runBareCli()).resolves.toBeUndefined();

    expect(readConfigFileSnapshotMock).toHaveBeenCalledOnce();
    expect(readLocalOnboardingStateMock).not.toHaveBeenCalled();
    expect(setupWizardCommandMock).toHaveBeenCalledWith({});
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(buildProgramMock).not.toHaveBeenCalled();
  });

  it("resumes pending local onboarding after inference persisted its model", async () => {
    const configPath = "/tmp/openclaw.json";
    const securityAcknowledgedAt = "2026-08-02T00:00:00.000Z";
    const sourceConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.6-luna" } } },
      wizard: { securityAcknowledgedAt },
    };
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      exists: true,
      valid: true,
      path: configPath,
      sourceConfig,
    });
    readLocalOnboardingStateMock.mockReturnValueOnce({
      version: 1,
      status: "pending",
      runId: "pending-onboarding",
      configPath,
      workspace: "/tmp/workspace",
      securityAcknowledgedAt,
      startedAtMs: 1,
    });

    await runBareCli();

    expect(readLocalOnboardingStateMock).toHaveBeenCalledWith(configPath, sourceConfig);
    expect(setupWizardCommandMock).toHaveBeenCalledWith({});
    expect(probeGatewayConfiguredModelMock).not.toHaveBeenCalled();
    expect(runTuiMock).not.toHaveBeenCalled();
  });

  registerBareRootArgumentTests({
    runCli: (argv) => runCli(argv),
    readConfigFileSnapshotMock,
    buildProgramMock,
    setupWizardCommandMock,
    runTuiMock,
    tryRouteCliMock,
    withInteractiveTty,
    expectNonInteractiveBareCliError,
  });

  it.each(["ws://127.0.0.1:18789"])(
    "configures missing inference on the selected remote Gateway: %s",
    async (url) => {
      const sourceConfig = {
        agents: { defaults: { model: { primary: "openai/local-only-model" } } },
        gateway: {
          mode: "remote",
          remote: {
            url,
            token: "missing-inference-remote-auth",
            tlsFingerprint: `sha256:${TLS_FINGERPRINT.toUpperCase()}`,
          },
        },
      };
      readConfigFileSnapshotMock.mockResolvedValueOnce({ exists: true, valid: true, sourceConfig });
      probeGatewayConfiguredModelMock.mockImplementationOnce(async (options) =>
        options.url === "ws://127.0.0.1:18789" && !options.originScopedDeviceAuth
          ? { kind: "reachable-unverified", detail: "missing scope: operator.read" }
          : {
              kind: "missing-configured-model",
              detail: "Gateway default agent has no configured model",
            },
      );

      await runBareCli();

      expect(setupWizardCommandMock).not.toHaveBeenCalled();
      expect(readLocalOnboardingStateMock).not.toHaveBeenCalled();
      expect(runRemoteGatewayInferenceOnboardingMock).toHaveBeenCalledWith({
        config: sourceConfig,
        gatewayUrl: url,
        configuredRemote: true,
        token: "missing-inference-remote-auth",
        tlsFingerprint: TLS_FINGERPRINT,
      });
      expect(runTuiMock).not.toHaveBeenCalled();
    },
  );

  it("does not direct non-interactive remote setup into local onboarding", async () => {
    primeBareRootConfig({
      gateway: {
        mode: "remote",
        remote: { url: "wss://gateway.example/ws", token: "noninteractive-remote-auth" },
      },
    });
    probeGatewayConfiguredModelMock.mockResolvedValueOnce({
      kind: "missing-configured-model",
      detail: "Gateway default agent has no configured model",
    });
    await expectNonInteractiveBareCliError(
      "Remote Gateway inference setup needs an interactive TTY. Re-run `openclaw` in a terminal connected to this Gateway.",
      () => {
        expect(setupWizardCommandMock).not.toHaveBeenCalled();
        expect(runRemoteGatewayInferenceOnboardingMock).not.toHaveBeenCalled();
      },
    );
  });

  it("uses the active local gateway lock port for bare root preflight and TUI handoff", async () => {
    primeBareRootConfig({
      gateway: {
        mode: "local",
        port: 18789,
        auth: { mode: "token", token: "configured-token" },
      },
    });
    readActiveGatewayLockPortMock.mockResolvedValueOnce(48789);

    await runBareCli();

    expectGatewayTarget({ url: "ws://127.0.0.1:48789", token: "configured-token" });
  });

  it("carries the canonical local TLS fingerprint through bare root", async () => {
    primeBareRootConfig({
      gateway: {
        mode: "local",
        tls: { enabled: true },
        auth: { mode: "token", token: "configured-token" },
      },
    });
    inspectGatewayTlsCertificateMock.mockResolvedValueOnce({
      ok: true,
      value: { cert: "public-certificate", fingerprintSha256: TLS_FINGERPRINT },
    });

    await runBareCli();

    expectGatewayTarget({
      url: "wss://127.0.0.1:18789",
      token: "configured-token",
      tlsFingerprint: TLS_FINGERPRINT,
    });
  });

  it("resolves only the configured auth-mode SecretRef for bare root preflight", async () => {
    const tempDir = tempDirs.make("openclaw-bare-auth-mode-");
    const tokenMarker = path.join(tempDir, "token-provider-ran");
    const passwordMarker = path.join(tempDir, "password-provider-ran");
    const tokenProgram = [
      "const fs=require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(tokenMarker)},'1');`,
      "process.stdout.write(JSON.stringify({ protocolVersion: 1, values: { TOKEN_SECRET: 'token-from-exec' } }));", // pragma: allowlist secret
    ].join("");
    const passwordProgram = [
      "const fs=require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(passwordMarker)},'1');`,
      "process.stdout.write(JSON.stringify({ protocolVersion: 1, values: { PASSWORD_SECRET: 'password-from-exec' } }));", // pragma: allowlist secret
    ].join("");
    await withSecureTestNodeExecPath(async () => {
      primeBareRootConfig({
        secrets: {
          providers: {
            tokenprovider: {
              source: "exec",
              command: process.execPath,
              args: ["-e", tokenProgram],
              allowInsecurePath: true,
            },
            passwordprovider: {
              source: "exec",
              command: process.execPath,
              args: ["-e", passwordProgram],
              allowInsecurePath: true,
            },
          },
        },
        gateway: {
          mode: "local",
          auth: {
            mode: "password",
            token: { source: "exec", provider: "tokenprovider", id: "TOKEN_SECRET" },
            password: { source: "exec", provider: "passwordprovider", id: "PASSWORD_SECRET" },
          },
        },
      });

      await runBareCli();

      expect(probeGatewayConfiguredModelMock).toHaveBeenCalledWith({
        url: "ws://127.0.0.1:18789",
        password: "password-from-exec",
      });
      await expect(fs.access(tokenMarker)).rejects.toThrow();
      await expect(fs.access(passwordMarker)).resolves.toBeUndefined();
      expectBoundTui({
        url: "ws://127.0.0.1:18789",
        password: "password-from-exec",
      });
    });
  });

  it("prefers a configured secondary Gateway over a missing-model primary probe", async () => {
    primeBareRootConfig({
      gateway: {
        mode: "local",
        bind: "tailnet",
        auth: { mode: "token", token: "local-token" },
      },
    });
    resolveControlUiLinksMock.mockImplementation(({ bind }: { bind?: string } = {}) =>
      bind === "tailnet"
        ? { httpUrl: "http://100.64.0.10:18789/", wsUrl: "ws://100.64.0.10:18789" }
        : { httpUrl: "http://127.0.0.1:18789/", wsUrl: "ws://127.0.0.1:18789" },
    );
    probeGatewayConfiguredModelMock
      .mockResolvedValueOnce({
        kind: "missing-configured-model",
        detail: "Gateway default agent has no configured model",
      })
      .mockResolvedValueOnce({ kind: "configured" });

    await runBareCli();

    expect(setupWizardCommandMock).not.toHaveBeenCalled();
    expectBoundTui({ url: "ws://100.64.0.10:18789", token: "local-token" });
  });

  it("keeps confirmed missing inference ahead of an unverified secondary Gateway", async () => {
    primeBareRootConfig({
      agents: { defaults: { model: { primary: "openai/local-only-model" } } },
      gateway: {
        mode: "local",
        bind: "tailnet",
        auth: { mode: "token", token: "local-token" },
      },
    });
    resolveControlUiLinksMock.mockImplementation(({ bind }: { bind?: string } = {}) =>
      bind === "tailnet"
        ? { httpUrl: "http://100.64.0.10:18789/", wsUrl: "ws://100.64.0.10:18789" }
        : { httpUrl: "http://127.0.0.1:18789/", wsUrl: "ws://127.0.0.1:18789" },
    );
    probeGatewayConfiguredModelMock
      .mockResolvedValueOnce({ kind: "reachable-unverified", detail: "config.get: unauthorized" })
      .mockResolvedValueOnce({
        kind: "missing-configured-model",
        detail: "Gateway default agent has no configured model",
      });

    await runBareCli();

    expect(setupWizardCommandMock).toHaveBeenCalledWith({});
    expect(runTuiMock).not.toHaveBeenCalled();
  });

  it("keeps a reachable unverified Gateway ahead of local inference fallback", async () => {
    const url = "ws://127.0.0.1:18789";
    primeBareRootConfig({
      agents: { defaults: { model: { primary: "openai/local-only-model" } } },
      gateway: { mode: "remote", remote: { url, token: "unverified-remote-auth" } },
    });
    probeGatewayConfiguredModelMock.mockResolvedValueOnce({
      kind: "reachable-unverified",
      detail: "config.get: unauthorized",
    });

    await runBareCli();

    expect(setupWizardCommandMock).not.toHaveBeenCalled();
    expectBoundTui({ url, configuredRemote: true, token: "unverified-remote-auth" });
  });

  it("keeps a configured remote Gateway authoritative across a transient cold-restart probe", async () => {
    const url = "wss://gateway.example/ws";
    primeBareRootConfig({
      gateway: { mode: "remote", remote: { url, token: "restart-remote-auth" } },
    });
    probeGatewayConfiguredModelMock.mockResolvedValueOnce({
      kind: "unreachable",
      detail: "gateway restarting",
    });

    await runBareCli();

    expect(setupWizardCommandMock).not.toHaveBeenCalled();
    expect(runRemoteGatewayInferenceOnboardingMock).not.toHaveBeenCalled();
    expectBoundTui({ url, configuredRemote: true, token: "restart-remote-auth" });
  });

  it("routes an explicit roster with no configured inference to onboarding", async () => {
    primeBareRootConfig({
      agents: {
        ownership: "explicit",
        entries: { alpha: {}, beta: {} },
      },
    });
    probeGatewayConfiguredModelMock.mockResolvedValueOnce({
      kind: "unreachable",
      detail: "offline",
    });

    await runBareCli();

    expect(setupWizardCommandMock).toHaveBeenCalledWith({});
    expect(runTuiMock).not.toHaveBeenCalled();
  });

  it.each([{ label: "LAN IP", url: "ws://192.168.1.10:18789" }])(
    "does not probe a plaintext remote gateway over $label without opt-in",
    async ({ url }) => {
      primeBareRootConfig({
        gateway: {
          mode: "remote",
          remote: {
            url,
            token: "unsafe-remote-auth",
          },
        },
      });

      await withEnvAsync({ OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: undefined }, async () => {
        await runBareCli();
      });

      expect(probeGatewayConfiguredModelMock).not.toHaveBeenCalled();
      expect(setupWizardCommandMock).toHaveBeenCalledWith({});
      expect(runTuiMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "configured edge auth",
      url: "wss://gateway.example/ws",
      remote: { token: "test-token", edgeAuth: { "X-Edge-Auth": "test-secret" } },
      env: {},
      auth: { token: "test-token" },
    },
    {
      name: "configured password ahead of ambient auth",
      url: "ws://127.0.0.1:18789",
      remote: { password: "configured-remote-password" }, // pragma: allowlist secret
      env: { OPENCLAW_GATEWAY_PASSWORD: "obsolete-shell-pass-value" },
      auth: { password: "configured-remote-password" }, // pragma: allowlist secret
    },
    {
      name: "unresolved references without ambient substitution",
      url: "ws://127.0.0.1:18789",
      remote: {
        token: { source: "env" as const, provider: "default", id: "MISSING_REMOTE_GATEWAY_TOKEN" },
        password: {
          source: "env" as const,
          provider: "default",
          id: "MISSING_REMOTE_GATEWAY_PASSWORD",
        },
      },
      env: {
        MISSING_REMOTE_GATEWAY_TOKEN: undefined,
        MISSING_REMOTE_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: "shell-fallback-auth-value",
        OPENCLAW_GATEWAY_PASSWORD: "env-remote-password",
      },
      auth: {},
    },
    {
      name: "explicit plaintext private opt-in",
      url: "ws://192.168.1.10:18789",
      remote: { token: "private-remote-auth" },
      env: { OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1" },
      auth: { token: "private-remote-auth" },
    },
  ])("preserves $name through the probe and TUI handoff", async ({ url, remote, env, auth }) => {
    const config: OpenClawConfig = { gateway: { mode: "remote", remote: { url, ...remote } } };
    primeBareRootConfig(config);
    await withEnvAsync(env, runBareCli);
    expect(probeGatewayConfiguredModelMock).toHaveBeenCalledWith({
      url,
      originScopedDeviceAuth: true,
      configuredRemote: true,
      config,
      ...auth,
    });
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
    expectBoundTui({ url, configuredRemote: true, ...auth });
  });

  it("rejects configured bare root TUI startup without an interactive TTY", async () => {
    await expectNonInteractiveBareCliError(
      "OpenClaw TUI needs an interactive TTY. Use `openclaw agent --local ...` for automation.",
      () => expect(runTuiMock).not.toHaveBeenCalled(),
    );
  });

  it("routes invalid configured bare root invocations to classic doctor guidance", async () => {
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      exists: true,
      valid: false,
      sourceConfig: { gateway: { mode: "local" } },
    });

    await runBareCli();

    expect(readLocalOnboardingStateMock).not.toHaveBeenCalled();
    expect(setupWizardCommandMock).toHaveBeenCalledWith({ classic: true });
    expect(runTuiMock).not.toHaveBeenCalled();
  });

  it("points noninteractive invalid config to doctor before onboarding", async () => {
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      exists: true,
      valid: false,
      sourceConfig: { gateway: { mode: "local" } },
    });
    await expectNonInteractiveBareCliError(
      "OpenClaw config is invalid. Run `openclaw doctor --fix` before onboarding.",
      () => expect(setupWizardCommandMock).not.toHaveBeenCalled(),
    );
  });

  it("returns after a handled container-target invocation", async () => {
    const previousExitCode = process.exitCode;
    maybeRunCliInContainerMock.mockReturnValueOnce({ handled: true, exitCode: 7 });

    await runCli(cliArgs("--container", "demo", "status"));

    expect(maybeRunCliInContainerMock).toHaveBeenCalledWith(
      cliArgs("--container", "demo", "status"),
    );
    expect(enableConsoleCaptureMock).toHaveBeenCalledTimes(1);
    const captureOrder = enableConsoleCaptureMock.mock.invocationCallOrder[0] ?? 0;
    const containerOrder = maybeRunCliInContainerMock.mock.invocationCallOrder[0] ?? 0;
    expect(captureOrder).toBeGreaterThan(0);
    expect(containerOrder).toBeGreaterThan(captureOrder);
    expect(loadDotEnvMock).not.toHaveBeenCalled();
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(closeActiveMemorySearchManagersMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(7);
    process.exitCode = previousExitCode;
  });

  it("swallows Commander parse exits after recording the exit code", async () => {
    const exitCode = process.exitCode;
    const program = {
      commands: [{ name: () => "status" }],
      parseAsync: vi
        .fn()
        .mockRejectedValueOnce(
          new CommanderError(1, "commander.excessArguments", "too many arguments for 'status'"),
        ),
    };
    buildProgramMock.mockReturnValueOnce(program);

    await expect(runCli(cliArgs("status"))).resolves.toBeUndefined();

    expect(registerSubCliByNameMock.mock.calls).toEqual([[program, "status", cliArgs("status")]]);
    expect(process.exitCode).toBe(1);
    process.exitCode = exitCode;
  });

  it("requests a flushed one-shot exit after Commander renders help", async () => {
    const exitCode = process.exitCode;
    const program = {
      commands: [{ name: () => "security" }],
      parseAsync: vi
        .fn()
        .mockRejectedValueOnce(new CommanderError(0, "commander.helpDisplayed", "help displayed")),
    };
    buildProgramMock.mockReturnValueOnce(program);

    await runCli(cliArgs("security", "--help"));

    expect(requestExitAfterOneShotOutputMock).toHaveBeenCalledOnce();
    expect(flushExitAfterOneShotOutputMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    process.exitCode = exitCode;
  });

  it.each([false, true])(
    "restores terminal state before uncaught CLI exits (machine output: %s)",
    async (machineOutput) => {
      buildProgramMock.mockReturnValueOnce({
        commands: [{ name: () => "status" }],
        parseAsync: vi.fn().mockResolvedValueOnce(undefined),
      });

      const processOnSpy = vi.spyOn(process, "on");
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${String(code)})`);
      }) as typeof process.exit);

      await runCli(cliArgs("status"));

      const handler = processOnSpy.mock.calls.find(([event]) => event === "uncaughtException")?.[1];
      if (typeof handler !== "function") {
        throw new Error("uncaughtException handler was not registered");
      }

      try {
        loggingState.forceConsoleToStderr = machineOutput;
        expect(() => handler(new Error("boom"))).toThrow("process.exit(1)");
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          "[openclaw] OpenClaw hit an unexpected runtime error.",
        );
        expect(consoleErrorSpy).toHaveBeenCalledWith("[openclaw] Reason: boom");
        expect(restoreRuntimeTerminalStateMock).toHaveBeenCalledWith("uncaught exception", {
          resumeStdinIfPaused: false,
        });
      } finally {
        loggingState.forceConsoleToStderr = false;
        if (typeof handler === "function") {
          process.off("uncaughtException", handler);
        }
        consoleErrorSpy.mockRestore();
        exitSpy.mockRestore();
        processOnSpy.mockRestore();
      }
    },
  );

  it("does not exit for transient uncaught CLI exceptions", async () => {
    buildProgramMock.mockReturnValueOnce({
      commands: [{ name: () => "status" }],
      parseAsync: vi.fn().mockResolvedValueOnce(undefined),
    });

    const processOnSpy = vi.spyOn(process, "on");
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${String(code)})`);
    }) as typeof process.exit);

    await runCli(cliArgs("status"));

    const handler = processOnSpy.mock.calls.find(([event]) => event === "uncaughtException")?.[1];
    if (typeof handler !== "function") {
      throw new Error("uncaughtException handler was not registered");
    }

    try {
      const hostUnreachable = Object.assign(new Error("connect EHOSTUNREACH 149.154.167.220:443"), {
        code: "EHOSTUNREACH",
      });
      expect(handler(hostUnreachable)).toBeUndefined();
      expect(consoleWarnSpy.mock.calls).toEqual([
        ["[openclaw] Non-fatal uncaught exception (continuing):", hostUnreachable.stack],
      ]);
      expect(restoreRuntimeTerminalStateMock).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      if (typeof handler === "function") {
        process.off("uncaughtException", handler);
      }
      consoleWarnSpy.mockRestore();
      exitSpy.mockRestore();
      processOnSpy.mockRestore();
    }
  });
  it("keeps a completed model-only onboarding on its existing local TUI path", async () => {
    const configPath = "/tmp/openclaw.json";
    const securityAcknowledgedAt = "2026-08-02T00:00:00.000Z";
    const sourceConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.6-luna" } } },
      wizard: { securityAcknowledgedAt },
    };
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      exists: true,
      valid: true,
      path: configPath,
      sourceConfig,
    });
    readLocalOnboardingStateMock.mockReturnValueOnce({
      version: 1,
      status: "completed",
      runId: "completed-onboarding",
      configPath,
      workspace: "/tmp/workspace",
      securityAcknowledgedAt,
      startedAtMs: 1,
      completedAtMs: 2,
    });
    probeGatewayConfiguredModelMock.mockResolvedValueOnce({ kind: "unreachable" });

    await runBareCli();

    expect(readLocalOnboardingStateMock).toHaveBeenCalledWith(configPath, sourceConfig);
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
    expect(runTuiMock).toHaveBeenCalledWith({
      deliver: false,
      local: true,
      forceProcessExitOnReturn: true,
    });
  });

  it("loads the real primary command before rendering command help", async () => {
    const program = {
      commands: [{ name: () => "doctor" }],
      parseAsync: vi.fn().mockResolvedValueOnce(undefined),
    };
    buildProgramMock.mockReturnValueOnce(program);
    const ctx = { programVersion: "0.0.0-test" };
    getProgramContextMock.mockReturnValueOnce(ctx as never);

    await runCli(["node", "openclaw", "doctor", "--help"]);

    expect(registerCoreCliByNameMock.mock.calls).toEqual([[program, ctx, "doctor"]]);
    expect(registerSubCliByNameMock.mock.calls).toEqual([
      [program, "doctor", ["node", "openclaw", "doctor", "--help"]],
    ]);
  });

  it("passes config get machine ownership into route-first startup", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);

    await runCli(["node", "openclaw", "config", "get", "gateway.port"]);

    expect(tryRouteCliMock).toHaveBeenCalledWith(
      ["node", "openclaw", "config", "get", "gateway.port"],
      { machineOutput: true },
    );
  });

  it("keeps plain config startup out of machine-output mode", async () => {
    tryRouteCliMock.mockResolvedValueOnce(false);
    const parseAsync = vi.fn(async () => expect(progressDoneMock).toHaveBeenCalled());
    buildProgramMock.mockReturnValueOnce(makeProgram("config", parseAsync));

    await runCli(["node", "openclaw", "config"]);

    expect(createCliProgressMock).toHaveBeenCalledWith({
      label: "Loading OpenClaw CLI…",
      indeterminate: true,
      delayMs: 0,
    });
    expect(parseAsync).toHaveBeenCalledWith(["node", "openclaw", "config"]);
  });

  it.each([
    ["status JSON", ["node", "openclaw", "models", "--status-json"]],
    ["status plain", ["node", "openclaw", "models", "--status-plain"]],
  ])("keeps models %s output free of proxy startup", async (_name, argv) => {
    tryRouteCliMock.mockResolvedValueOnce(true);
    await runCli(argv);
    expect(startProxyMock).not.toHaveBeenCalled();
    expect(stopProxyMock).not.toHaveBeenCalled();
  });
  it("suppresses startup progress for plain model output before full CLI parsing", async () => {
    tryRouteCliMock.mockResolvedValueOnce(false);
    const parseAsync = vi.fn(async () => expect(progressDoneMock).toHaveBeenCalled());
    buildProgramMock.mockReturnValueOnce(makeProgram("models", parseAsync));

    await runCli(["node", "openclaw", "models", "aliases", "list", "--plain"]);

    expect(createCliProgressMock).toHaveBeenCalledWith({
      label: "Loading OpenClaw CLI…",
      indeterminate: true,
      delayMs: 0,
      enabled: false,
    });
    expect(parseAsync).toHaveBeenCalledWith([
      "node",
      "openclaw",
      "models",
      "aliases",
      "list",
      "--plain",
    ]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
