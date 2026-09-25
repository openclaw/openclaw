// Install this fixture before importing Gateway owners so their dependencies see the mocks.
import { Command } from "commander";
import { afterAll, beforeAll, beforeEach, expect, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import { GATEWAY_SERVICE_RUNTIME_PID_ENV } from "../../daemon/constants.js";
import { SUPERVISOR_HINT_ENV_VARS } from "../../infra/supervisor-markers.js";
import { captureEnv, deleteTestEnvValue } from "../../test-utils/env.js";
import { createCliRuntimeCapture } from "../test-runtime-capture.js";

export const startGatewayServer = vi.fn(async (_port: number, _opts?: unknown) => ({
  close: vi.fn(async () => {}),
}));
const triageAfterFailure = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../commands/triage-failure.js", () => ({ triageAfterFailure }));
export const setGatewayWsLogStyle = vi.fn((_style: string) => undefined);
const setVerbose = vi.fn((_enabled: boolean) => undefined);
export const setConsoleSubsystemFilter = vi.fn((_filters: string[]) => undefined);
export const forceFreePortAndWait = vi.fn(async (_port: number, _opts: unknown) => ({
  killed: [],
  waitedMs: 0,
  escalatedToSigkill: false,
}));
export const cleanStaleGatewayProcessesSync = vi.fn(
  (_port?: number, _options?: { protectedPid?: number }) => [],
);
export const warnAboutGatewayRestartStorm = vi.fn(
  async (_env: NodeJS.ProcessEnv, _warn: (message: string) => void) => {},
);
export const waitForPortBindable = vi.fn(async (_port: number, _opts?: unknown) => 0);
export const findVerifiedGatewayListenerPidsOnPortSync = vi.fn((_port: number) => [] as number[]);
const formatGatewayPidList = vi.fn((pids: number[]) => pids.join(", "));
export const isTerminalInteractive = vi.fn(() => true);
export const offerInvalidConfigRecovery = vi.fn(async () => ({ status: "declined" as const }));
export const parkCurrentLaunchAgentForMaintenance = vi.fn(async () => false);
export const ensureDevGatewayConfig = vi.fn(async (_opts?: unknown) => {});
type GatewayLoopStart = (params?: { startupStartedAt?: number }) => Promise<unknown>;
type GatewayLoopParams = {
  start: GatewayLoopStart;
  completeBoot?: (completion: unknown) => void;
  ownsProcessLifecycle?: boolean;
  runtime?: unknown;
};
export const runGatewayLoop = vi.fn(async ({ start }: GatewayLoopParams) => {
  await start();
});
export const normalizeStateDirEnv = vi.fn((_env?: NodeJS.ProcessEnv) => undefined);
export const pinConfigDir = vi.fn((_env?: NodeJS.ProcessEnv) => undefined);
export const pinRuntimePaths = vi.fn((_env?: NodeJS.ProcessEnv) => undefined);
export const detectRespawnSupervisor = vi.fn(() => null as "systemd" | null);
type RuntimeDotEnvLoadResult = {
  dotenvPresentKeys: string[];
  gatewayEnvAppliedKeys: string[];
  stateEnvAppliedKeys: string[];
};
export const loadGlobalRuntimeDotEnvFiles = vi.fn<
  (_opts?: unknown) => RuntimeDotEnvLoadResult | undefined
>(() => undefined);
export const beforeRun = vi.fn(async () => {
  callOrder.push("bootstrap");
});
const callOrder = vi.hoisted(() => [] as string[]);
export const refreshManagedProxy = vi.fn(async () => {
  callOrder.push("proxy");
});
export const loadShellEnvFallback = vi.fn((_opts?: unknown) => {
  callOrder.push("shell-env");
});
export const clearShellEnvAppliedKeys = vi.fn((_keys: readonly string[]) => undefined);
export const resolveShellEnvExpectedKeys = vi.fn(
  (_env?: NodeJS.ProcessEnv, _config?: OpenClawConfig) => ["OPENCLAW_GATEWAY_TOKEN"],
);
export const resolveShellEnvFallbackTimeoutMs = vi.fn((_env?: NodeJS.ProcessEnv) => 15_000);
export const shouldDeferShellEnvFallback = vi.fn((_env?: NodeJS.ProcessEnv) => false);
export const shouldEnableShellEnvFallback = vi.fn((_env?: NodeJS.ProcessEnv) => false);
const gatewayLogMessages = vi.hoisted(() => [] as string[]);
const gatewayErrorMessages = vi.hoisted(() => [] as string[]);
const configState = vi.hoisted(() => ({
  cfg: {} as Record<string, unknown>,
  snapshot: { config: {}, exists: false, sourceConfig: {}, valid: true } as Record<string, unknown>,
}));
const pristineStartupMigrationPlan = vi.hoisted(() => ({
  config: vi.fn(),
  state: vi.fn(),
}));
export const readBestEffortConfig = vi.fn(async () => configState.cfg);
type ConfigSnapshotReadOptionsStub = {
  isolateEnv?: boolean;
  lowerPrecedenceEnv?: Readonly<Record<string, string>>;
  observe?: boolean;
};
export const readConfigFileSnapshotWithPluginMetadata = vi.fn(
  async (_options?: ConfigSnapshotReadOptionsStub) => ({
    snapshot: configState.snapshot,
  }),
);
export const writeDiagnosticStabilityBundleForFailureSync = vi.fn(
  (_reason: string, _error: unknown) => ({
    status: "written" as const,
    message: "wrote stability bundle: /tmp/openclaw-stability.json",
    path: "/tmp/openclaw-stability.json",
  }),
);
const bootLifecycle = vi.hoisted(() => ({
  manualChannelStartHint: `Start a channel manually with: openclaw gateway call channels.start --params '{"channel":"<id>"}'`,
  decisions: [] as Array<{
    tripped: boolean;
    uncleanBoots: number;
    windowMs: number;
    shouldWriteStabilityBundle: boolean;
    recovered: boolean;
  }>,
  inspect: vi.fn(
    (_env?: NodeJS.ProcessEnv, _nowMs?: number) =>
      bootLifecycle.decisions.shift() ?? {
        tripped: false,
        uncleanBoots: 0,
        windowMs: 300_000,
        shouldWriteStabilityBundle: false,
        recovered: false,
      },
  ),
  record: vi.fn(
    (_env?: NodeJS.ProcessEnv, _nowMs?: number, _reason?: string): string | undefined => "boot-id",
  ),
  recover: vi.fn(
    (_bootId?: string, _env?: NodeJS.ProcessEnv, _nowMs?: number): string | undefined =>
      "recovered-boot-id",
  ),
  complete: vi.fn(),
}));
const netState = vi.hoisted(() => ({
  autoBindHost: "127.0.0.1",
  container: false,
}));
export const withoutSupervisorEnv = Object.fromEntries(
  SUPERVISOR_HINT_ENV_VARS.map((key) => [key, undefined]),
) as Record<string, string | undefined>;
export const withoutGatewayAuthEnv = {
  OPENCLAW_GATEWAY_TOKEN: undefined,
  OPENCLAW_GATEWAY_PASSWORD: undefined,
};

const { runtimeErrors, defaultRuntime, resetRuntimeCapture } = createCliRuntimeCapture();

export {
  bootLifecycle,
  callOrder,
  configState,
  defaultRuntime,
  gatewayErrorMessages,
  gatewayLogMessages,
  netState,
  pristineStartupMigrationPlan,
  runtimeErrors,
  triageAfterFailure,
};

vi.mock("../../config/config.js", () => ({
  getConfigPath: () => "/tmp/openclaw-test-missing-config.json",
  readBestEffortConfig: () => readBestEffortConfig(),
  readConfigFileSnapshot: async () => configState.snapshot,
  readConfigFileSnapshotWithPluginMetadata: (options?: ConfigSnapshotReadOptionsStub) =>
    readConfigFileSnapshotWithPluginMetadata(options),
}));

vi.mock("../../commands/doctor/shared/pristine-startup-state.js", () => ({
  planPristineStartupConfigMigrations: (config: unknown, env?: NodeJS.ProcessEnv) =>
    pristineStartupMigrationPlan.config(config, env),
  planPristineStartupStateMigrations: (env?: NodeJS.ProcessEnv) =>
    pristineStartupMigrationPlan.state(env),
}));

vi.mock("../../config/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/paths.js")>()),
  CONFIG_PATH: "/tmp/openclaw-test-missing-config.json",
  normalizeStateDirEnv: (env?: NodeJS.ProcessEnv) => normalizeStateDirEnv(env),
  pinRuntimePaths: (env?: NodeJS.ProcessEnv) => pinRuntimePaths(env),
  resolveConfigPath: () => "/tmp/openclaw-test-missing-config.json",
  resolveStateDir: () => "/tmp",
  resolveGatewayPort: (cfg?: { gateway?: { port?: number } }) => cfg?.gateway?.port ?? 18789,
}));

vi.mock("../../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils.js")>()),
  pinConfigDir: (env?: NodeJS.ProcessEnv) => pinConfigDir(env),
}));

vi.mock("../../infra/dotenv-global.js", () => ({
  loadGlobalRuntimeDotEnvFiles: (opts?: unknown) =>
    loadGlobalRuntimeDotEnvFiles(opts) ?? {
      dotenvPresentKeys: [],
      gatewayEnvAppliedKeys: [],
      stateEnvAppliedKeys: [],
    },
}));

vi.mock("../../config/shell-env-expected-keys.js", () => ({
  resolveShellEnvExpectedKeys: (...args: Parameters<typeof resolveShellEnvExpectedKeys>) =>
    resolveShellEnvExpectedKeys(...args),
}));

vi.mock("../../infra/shell-env.js", () => ({
  clearShellEnvAppliedKeys: (keys: readonly string[]) => clearShellEnvAppliedKeys(keys),
  loadShellEnvFallback: (opts?: unknown) => loadShellEnvFallback(opts),
  resolveShellEnvFallbackTimeoutMs: (env?: NodeJS.ProcessEnv) =>
    resolveShellEnvFallbackTimeoutMs(env),
  shouldDeferShellEnvFallback: (env?: NodeJS.ProcessEnv) => shouldDeferShellEnvFallback(env),
  shouldEnableShellEnvFallback: (env?: NodeJS.ProcessEnv) => shouldEnableShellEnvFallback(env),
}));

vi.mock("../../gateway/auth.js", () => ({
  resolveGatewayAuth: (params: {
    authConfig?: { mode?: string; token?: unknown; password?: unknown };
    authOverride?: { mode?: string; token?: unknown; password?: unknown };
    env?: NodeJS.ProcessEnv;
  }) => {
    const mode = params.authOverride?.mode ?? params.authConfig?.mode ?? "token";
    const token =
      (typeof params.authOverride?.token === "string" ? params.authOverride.token : undefined) ??
      (typeof params.authConfig?.token === "string" ? params.authConfig.token : undefined) ??
      params.env?.OPENCLAW_GATEWAY_TOKEN;
    const password =
      (typeof params.authOverride?.password === "string"
        ? params.authOverride.password
        : undefined) ??
      (typeof params.authConfig?.password === "string" ? params.authConfig.password : undefined) ??
      params.env?.OPENCLAW_GATEWAY_PASSWORD;
    return {
      mode,
      token,
      password,
      allowTailscale: false,
    };
  },
}));

vi.mock("../../gateway/net.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../gateway/net.js")>();
  return {
    ...actual,
    defaultGatewayBindMode: (tailscaleMode?: string) => {
      if (tailscaleMode && tailscaleMode !== "off") {
        return "loopback";
      }
      return netState.container ? "auto" : "loopback";
    },
    isContainerEnvironment: () => netState.container,
    resolveGatewayBindHost: async (bind?: string, customHost?: string) => {
      if (bind === "auto") {
        return netState.autoBindHost;
      }
      if (bind === "lan") {
        return "0.0.0.0";
      }
      if (bind === "custom") {
        return customHost?.trim() || "0.0.0.0";
      }
      if (bind === "tailnet") {
        return "100.64.0.1";
      }
      return "127.0.0.1";
    },
  };
});

vi.mock("../../infra/restart-stale-pids.js", () => ({
  cleanStaleGatewayProcessesSync: (port?: number, options?: { protectedPid?: number }) =>
    cleanStaleGatewayProcessesSync(port, options),
}));

vi.mock("../../daemon/restart-storm.js", () => ({
  warnAboutGatewayRestartStorm: (env: NodeJS.ProcessEnv, warn: (message: string) => void) =>
    warnAboutGatewayRestartStorm(env, warn),
}));

vi.mock("../../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync: (port: number) =>
    findVerifiedGatewayListenerPidsOnPortSync(port),
  formatGatewayPidList: (pids: number[]) => formatGatewayPidList(pids),
}));

vi.mock("../../gateway/server.js", () => ({
  startGatewayServer: (port: number, opts?: unknown) => startGatewayServer(port, opts),
}));

vi.mock("../../daemon/launchd.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/launchd.js")>()),
  parkCurrentLaunchAgentForMaintenance: () => parkCurrentLaunchAgentForMaintenance(),
}));

vi.mock("../../gateway/ws-logging.js", () => ({
  setGatewayWsLogStyle: (style: string) => setGatewayWsLogStyle(style),
}));

vi.mock("../../globals.js", () => ({
  setVerbose: (enabled: boolean) => setVerbose(enabled),
}));

vi.mock("../../infra/ports-inspect.js", () => ({
  inspectPortUsage: async () => ({ status: "free" }),
}));

vi.mock("../../infra/ports-format.js", () => ({ formatPortDiagnostics: () => [] }));

vi.mock("../../infra/supervisor-markers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/supervisor-markers.js")>();
  return {
    ...actual,
    detectRespawnSupervisor: () => detectRespawnSupervisor(),
  };
});

vi.mock("../../logging/console.js", () => ({
  setConsoleSubsystemFilter: (filters: string[]) => setConsoleSubsystemFilter(filters),
  setConsoleTimestampPrefix: () => undefined,
}));

vi.mock("../../logging/diagnostic-stability-bundle.js", () => ({
  writeDiagnosticStabilityBundleForFailureSync: (reason: string, error: unknown) =>
    writeDiagnosticStabilityBundleForFailureSync(reason, error),
}));

vi.mock("../../infra/gateway-boot-lifecycle.js", () => ({
  GATEWAY_CRASH_LOOP_BREAKER_REASON: "gateway.crash_loop_breaker",
  formatGatewayCrashLoopManualChannelStartHint: () => bootLifecycle.manualChannelStartHint,
  GATEWAY_CRASH_LOOP_RECOVERED_REASON: "gateway.crash_loop_recovered",
  inspectGatewayCrashLoopBreaker: (env?: NodeJS.ProcessEnv, nowMs?: number) =>
    bootLifecycle.inspect(env, nowMs),
  recordGatewayBootStart: (env?: NodeJS.ProcessEnv, nowMs?: number, reason?: string) =>
    bootLifecycle.record(env, nowMs, reason),
  recordGatewayCrashLoopRecovery: (bootId?: string, env?: NodeJS.ProcessEnv, nowMs?: number) =>
    bootLifecycle.recover(bootId, env, nowMs),
  completeGatewayBootLifecycle: (bootId: string | undefined, completion: unknown) =>
    bootLifecycle.complete(bootId, completion),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    debug: () => undefined,
    info: (message: string) => {
      gatewayLogMessages.push(message);
    },
    warn: (message: string) => {
      gatewayLogMessages.push(message);
    },
    error: (message: string) => {
      gatewayErrorMessages.push(message);
    },
  }),
}));

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime,
}));

vi.mock("../command-format.js", () => ({
  formatCliCommand: (cmd: string) => cmd,
}));

vi.mock("../terminal-interactivity.js", () => ({
  isTerminalInteractive: () => isTerminalInteractive(),
  NON_INTERACTIVE_GATEWAY_RUN_FORCE_MESSAGE:
    "Refusing to kill the operator's running gateway service from a non-interactive shell. Use an isolated dev gateway (openclaw gateway run --dev, or --profile <name> with a free port) for testing.",
}));

vi.mock("../invalid-config-recovery.js", () => ({
  offerInvalidConfigRecovery: () => offerInvalidConfigRecovery(),
}));

vi.mock("../ports.js", () => ({
  forceFreePortAndWait: (port: number, opts: unknown) => forceFreePortAndWait(port, opts),
  waitForPortBindable: (port: number, opts?: unknown) => waitForPortBindable(port, opts),
}));

vi.mock("./dev.js", () => ({
  ensureDevGatewayConfig: (opts?: unknown) => ensureDevGatewayConfig(opts),
}));

vi.mock("./run-loop.js", () => ({
  runGatewayLoop: (params: { start: GatewayLoopStart }) => runGatewayLoop(params),
}));

let addGatewayRunCommand: typeof import("./run-command.js").addGatewayRunCommand;
let sharedProgram: Command;

export function installGatewayRunOptionCollisionFixture() {
  // gateway run exports --token/--password into process.env as a side effect
  // (see runGatewayCli auth wiring); snapshot and clear them so shared vitest
  // workers do not leak credentials into later files' gateway connects.
  const serviceEnvSnapshot = captureEnv([
    "OPENCLAW_SERVICE_MARKER",
    "OPENCLAW_SERVICE_KIND",
    GATEWAY_SERVICE_RUNTIME_PID_ENV,
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_GATEWAY_PASSWORD",
  ]);

  beforeAll(async () => {
    ({ addGatewayRunCommand } = await import("./run-command.js"));
    sharedProgram = new Command();
    sharedProgram.exitOverride();
    const gateway = addGatewayRunCommand(sharedProgram.command("gateway"), { beforeRun });
    addGatewayRunCommand(gateway.command("run"), { beforeRun });
  });

  afterAll(() => {
    serviceEnvSnapshot.restore();
  });

  beforeEach(() => {
    delete process.env.OPENCLAW_SERVICE_MARKER;
    delete process.env.OPENCLAW_SERVICE_KIND;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    deleteTestEnvValue(GATEWAY_SERVICE_RUNTIME_PID_ENV);
    resetRuntimeCapture();
    configState.cfg = {};
    configState.snapshot = { config: {}, exists: false, sourceConfig: {}, valid: true };
    pristineStartupMigrationPlan.config.mockReset();
    pristineStartupMigrationPlan.config.mockReturnValue({
      skipAllStateMigrations: false,
      skipCoreStateMigrations: false,
    });
    pristineStartupMigrationPlan.state.mockReset();
    pristineStartupMigrationPlan.state.mockReturnValue({
      skipAllStateMigrations: false,
      skipCoreStateMigrations: false,
    });
    netState.autoBindHost = "127.0.0.1";
    netState.container = false;
    detectRespawnSupervisor.mockReset().mockReturnValue(null);
    readBestEffortConfig.mockClear();
    readConfigFileSnapshotWithPluginMetadata.mockClear();
    gatewayLogMessages.length = 0;
    gatewayErrorMessages.length = 0;
    writeDiagnosticStabilityBundleForFailureSync.mockClear();
    bootLifecycle.decisions.length = 0;
    bootLifecycle.inspect.mockClear();
    bootLifecycle.record.mockClear();
    triageAfterFailure.mockClear();
    bootLifecycle.recover.mockClear();
    bootLifecycle.complete.mockClear();
    startGatewayServer.mockClear();
    setGatewayWsLogStyle.mockClear();
    setVerbose.mockClear();
    setConsoleSubsystemFilter.mockClear();
    forceFreePortAndWait.mockClear();
    findVerifiedGatewayListenerPidsOnPortSync.mockReset();
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
    formatGatewayPidList.mockClear();
    isTerminalInteractive.mockReset();
    isTerminalInteractive.mockReturnValue(true);
    offerInvalidConfigRecovery.mockClear();
    parkCurrentLaunchAgentForMaintenance.mockReset();
    parkCurrentLaunchAgentForMaintenance.mockResolvedValue(false);
    cleanStaleGatewayProcessesSync.mockClear();
    warnAboutGatewayRestartStorm.mockReset();
    waitForPortBindable.mockClear();
    ensureDevGatewayConfig.mockClear();
    runGatewayLoop.mockClear();
    normalizeStateDirEnv.mockReset();
    pinConfigDir.mockClear();
    pinRuntimePaths.mockClear();
    loadGlobalRuntimeDotEnvFiles.mockReset();
    beforeRun.mockClear();
    refreshManagedProxy.mockClear();
    loadShellEnvFallback.mockClear();
    clearShellEnvAppliedKeys.mockClear();
    resolveShellEnvExpectedKeys.mockClear();
    resolveShellEnvFallbackTimeoutMs.mockClear();
    shouldDeferShellEnvFallback.mockReset();
    shouldDeferShellEnvFallback.mockReturnValue(false);
    shouldEnableShellEnvFallback.mockReset();
    shouldEnableShellEnvFallback.mockReturnValue(false);
    callOrder.length = 0;
  });
}

export async function runGatewayCli(argv: string[]) {
  await sharedProgram.parseAsync(argv, { from: "user" });
}

export async function prepareGatewayReset() {
  const { prepareGatewayRunBootstrap } = await import("./pre-bootstrap.js");
  return await prepareGatewayRunBootstrap({ opts: { reset: true }, runtime: defaultRuntime });
}

export function callArg(mock: { mock: { calls: unknown[][] } }, index = 0, argIndex = 0): unknown {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected mock call ${index}`);
  }
  return call[argIndex];
}

export function gatewayStartOptions(index = 0) {
  expect(startGatewayServer.mock.calls[index]?.[0]).toBe(18789);
  return callArg(startGatewayServer, index, 1) as {
    auth?: { mode?: string; token?: string; password?: string };
    bind?: string;
    channelAutostartSuppression?: { reason?: string; message?: string };
    tryRecoverChannelAutostartSuppression?: () => boolean;
    ambientEnvTriggers?: "allow" | "suppress";
    startupConfigSnapshotRead?: { snapshot?: Record<string, unknown> };
    startupStartedAt?: number;
  };
}

export function expectAuthOverrideMode(mode: string) {
  expect(gatewayStartOptions().auth?.mode).toBe(mode);
}
