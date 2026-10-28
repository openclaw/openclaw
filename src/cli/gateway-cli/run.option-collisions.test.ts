import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_AUDIT_STORE_LABEL } from "../../config/io.audit.js";
import type { ConfigSnapshotReadOptions } from "../../config/io.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../config/types.js";
import { GATEWAY_SERVICE_RUNTIME_PID_ENV } from "../../daemon/constants.js";
import type { GatewayServerOptions } from "../../gateway/server-public.js";
import { createNewerSqliteSchemaVersionError } from "../../infra/sqlite-user-version.js";
import { SUPERVISOR_HINT_ENV_VARS } from "../../infra/supervisor-markers.js";
import { OpenClawDatabaseSchemaPreflightError } from "../../state/openclaw-database-preflight.js";
import { OpenClawStateDatabaseSchemaMigrationRequiredError } from "../../state/openclaw-state-db-schema-migration-required.js";
import {
  captureEnv,
  deleteTestEnvValue,
  setTestEnvValue,
  withEnvAsync,
} from "../../test-utils/env.js";
import { withTempSecretFiles } from "../../test-utils/secret-file-fixture.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import { VERSION } from "../../version.js";
import { createCliRuntimeCapture } from "../test-runtime-capture.js";
import {
  registerGatewayRunCleanupReceiptTests,
  type GatewayLoopParams,
} from "./run-cleanup-receipt.test-support.js";
import {
  failedGatewayRunConfigSnapshot,
  completeGatewayRunSnapshot as completeSnapshot,
  registerInvalidConfigResetTests,
  gatewayRunReadFailures,
  type RuntimeDotEnvLoadResult,
} from "./run-config.test-support.js";
import { registerGatewayLockFailureTests } from "./run-lock-failure.test-support.js";
import { installGatewayRunRuntimeHooks } from "./runtime-hooks.js";

const mocks = vi.hoisted(() => ({
  startGatewayServer: vi.fn(async (_port: number, _opts?: unknown) => ({
    close: vi.fn(async () => {}),
  })),
  triageAfterFailure: vi.fn(async () => undefined),
  setGatewayWsLogStyle: vi.fn((_style: string) => undefined),
  setConsoleSubsystemFilter: vi.fn((_filters: string[]) => undefined),
  forceFreePortAndWait: vi.fn(async (_port: number, _opts: unknown) => ({
    killed: [],
    waitedMs: 0,
    escalatedToSigkill: false,
  })),
  cleanStaleGatewayProcessesSync: vi.fn(
    (_port?: number, _options?: { protectedPid?: number }) => [],
  ),
  warnAboutGatewayRestartStorm: vi.fn(
    async (_env: NodeJS.ProcessEnv, _warn: (message: string) => void) => {},
  ),
  waitForPortBindable: vi.fn(async (_port: number, _opts?: unknown) => 0),
  findVerifiedGatewayListenerPidsOnPortSync: vi.fn((_port: number) => [] as number[]),
  isTerminalInteractive: vi.fn(() => true),
  offerInvalidConfigRecovery: vi.fn(async () => false),
  parkCurrentLaunchAgentForMaintenance: vi.fn(async () => false),
  ensureDevGatewayConfig: vi.fn(async (_opts?: unknown) => {}),
  runGatewayLoop: vi.fn(async ({ start }: GatewayLoopParams) => {
    await start();
  }),
  normalizeStateDirEnv: vi.fn((_env?: NodeJS.ProcessEnv) => undefined),
  pinConfigDir: vi.fn((_env?: NodeJS.ProcessEnv) => undefined),
  pinRuntimePaths: vi.fn((_env?: NodeJS.ProcessEnv) => undefined),
  detectRespawnSupervisor: vi.fn(() => null as "systemd" | null),
  loadGlobalRuntimeDotEnvFiles: vi.fn<(_opts?: unknown) => RuntimeDotEnvLoadResult | undefined>(
    () => undefined,
  ),
  beforeRun: vi.fn(async () => {}),
  refreshManagedProxy: vi.fn(async () => {}),
  loadShellEnvFallback: vi.fn((_opts?: unknown) => {}),
  clearShellEnvAppliedKeys: vi.fn((_keys: readonly string[]) => undefined),
  resolveShellEnvExpectedKeys: vi.fn((_env?: NodeJS.ProcessEnv, _config?: OpenClawConfig) => [
    "OPENCLAW_GATEWAY_TOKEN",
  ]),
  shouldDeferShellEnvFallback: vi.fn((_env?: NodeJS.ProcessEnv) => false),
  shouldEnableShellEnvFallback: vi.fn((_env?: NodeJS.ProcessEnv) => false),
}));
const { startGatewayServer, runGatewayLoop, beforeRun, triageAfterFailure } = mocks;
const { setGatewayWsLogStyle, setConsoleSubsystemFilter } = mocks;
const { forceFreePortAndWait, waitForPortBindable, findVerifiedGatewayListenerPidsOnPortSync } =
  mocks;
const { cleanStaleGatewayProcessesSync, warnAboutGatewayRestartStorm } = mocks;
const { isTerminalInteractive, offerInvalidConfigRecovery } = mocks;
const { parkCurrentLaunchAgentForMaintenance, ensureDevGatewayConfig } = mocks;
const { normalizeStateDirEnv, pinConfigDir, pinRuntimePaths, detectRespawnSupervisor } = mocks;
const { loadGlobalRuntimeDotEnvFiles, refreshManagedProxy, loadShellEnvFallback } = mocks;
const { clearShellEnvAppliedKeys } = mocks;
const { shouldDeferShellEnvFallback, shouldEnableShellEnvFallback } = mocks;
// mock-isolation: Record triage requests without running live diagnostics.
vi.mock("../../commands/triage-failure.js", () => ({
  triageAfterFailure: mocks.triageAfterFailure,
}));
const gatewayLogMessages = vi.hoisted(() => [] as string[]);
const gatewayErrorMessages = vi.hoisted(() => [] as string[]);
const configState = vi.hoisted(() => ({
  cfg: {} as Record<string, unknown>,
  snapshot: { config: {}, exists: false, sourceConfig: {}, valid: true } as Record<string, unknown>,
}));
const readBestEffortConfig = vi.fn(async () => configState.cfg);
const readConfigFileSnapshotWithPluginMetadata = vi.hoisted(() =>
  vi.fn(async (_options?: ConfigSnapshotReadOptions) => ({
    snapshot: configState.snapshot,
  })),
);
const writeDiagnosticStabilityBundleForFailureSync = vi.hoisted(() =>
  vi.fn((_reason: string, _error: unknown) => ({
    status: "written" as const,
    message: "wrote stability bundle: /tmp/openclaw-stability.json",
    path: "/tmp/openclaw-stability.json",
  })),
);
function bootDecision(tripped = false, recovered = false) {
  return {
    tripped,
    uncleanBoots: tripped ? 3 : 0,
    windowMs: 300_000,
    shouldWriteStabilityBundle: tripped,
    recovered,
  };
}
const bootLifecycle = vi.hoisted(() => ({
  manualChannelStartHint: `Start a channel manually with: openclaw channels start --channel <id>`,
  decisions: [] as ReturnType<typeof bootDecision>[],
  inspect: vi.fn(
    (_env?: NodeJS.ProcessEnv, _nowMs?: number) =>
      bootLifecycle.decisions.shift() ?? bootDecision(),
  ),
  nextBootId: vi.fn((): string | undefined => "boot-id"),
  begin: vi.fn(async (env?: NodeJS.ProcessEnv, nowMs?: number) => ({
    id: bootLifecycle.nextBootId(),
    decision: bootLifecycle.inspect(env, nowMs),
  })),
  recover: vi.fn(
    async (
      _bootId?: string,
      _env?: NodeJS.ProcessEnv,
      _nowMs?: number,
      _assertCurrent?: () => void,
    ): Promise<string | undefined> => "recovered-boot-id",
  ),
  complete: vi.fn(),
}));
const netState = vi.hoisted(() => ({
  autoBindHost: "127.0.0.1",
  container: false,
}));
const withoutSupervisorEnv = Object.fromEntries(
  SUPERVISOR_HINT_ENV_VARS.map((key) => [key, undefined]),
) as Record<string, string | undefined>;
const withoutGatewayAuthEnv = {
  OPENCLAW_GATEWAY_TOKEN: undefined,
  OPENCLAW_GATEWAY_PASSWORD: undefined,
};

const { runtimeErrors, defaultRuntime, resetRuntimeCapture } = createCliRuntimeCapture();
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

// mock-isolation: Use the synthetic config snapshot without reading operator config.
vi.mock("../../config/config.js", () => ({
  getConfigPath: () => "/tmp/openclaw-test-missing-config.json",
  readBestEffortConfig: () => readBestEffortConfig(),
  readConfigFileSnapshot: async () => configState.snapshot,
  readConfigFileSnapshotWithPluginMetadata,
}));

// mock-isolation: CLI option cases use the synthetic config snapshot without filesystem recovery.
vi.mock("../../config/io.factory.js", () => ({
  createConfigIO: () => ({
    readConfigFileSnapshot: async () => configState.snapshot,
    prepareConfigRecovery: async () => null,
  }),
}));

vi.mock("../../config/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/paths.js")>()),
  CONFIG_PATH: "/tmp/openclaw-test-missing-config.json",
  normalizeStateDirEnv: mocks.normalizeStateDirEnv,
  pinRuntimePaths: mocks.pinRuntimePaths,
  resolveConfigPath: () => "/tmp/openclaw-test-missing-config.json",
  resolveStateDir: (env?: NodeJS.ProcessEnv) => env?.OPENCLAW_STATE_DIR ?? "/tmp",
  resolveGatewayPort: (cfg?: { gateway?: { port?: number } }) => cfg?.gateway?.port ?? 18789,
}));

vi.mock("../../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils.js")>()),
  pinConfigDir: mocks.pinConfigDir,
}));

vi.mock("../../infra/dotenv-global.js", () => ({
  loadGlobalRuntimeDotEnvFiles: (opts?: unknown) =>
    loadGlobalRuntimeDotEnvFiles(opts) ?? {
      dotenvPresentKeys: [],
      gatewayEnvAppliedKeys: [],
      stateEnvAppliedKeys: [],
    },
}));

// mock-isolation: Keep shell environment discovery out of the CLI fixture.
vi.mock("../../config/shell-env-expected-keys.js", () => ({
  resolveShellEnvExpectedKeys: mocks.resolveShellEnvExpectedKeys,
}));

// mock-isolation: Prevent login-shell execution in CLI option tests.
vi.mock("../../infra/shell-env.js", () => ({
  clearShellEnvAppliedKeys: mocks.clearShellEnvAppliedKeys,
  loadShellEnvFallback: mocks.loadShellEnvFallback,
  resolveShellEnvFallbackTimeoutMs: () => 15_000,
  shouldDeferShellEnvFallback: mocks.shouldDeferShellEnvFallback,
  shouldEnableShellEnvFallback: mocks.shouldEnableShellEnvFallback,
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

// mock-isolation: Record stale-process recovery without signaling processes.
vi.mock("../../infra/restart-stale-pids.js", () => ({
  cleanStaleGatewayProcessesSync: mocks.cleanStaleGatewayProcessesSync,
}));

// mock-isolation: Control restart decisions without reading service history.
vi.mock("../../daemon/restart-storm.js", () => ({
  warnAboutGatewayRestartStorm: mocks.warnAboutGatewayRestartStorm,
}));

// mock-isolation: Prevent real Gateway process discovery.
vi.mock("../../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync: mocks.findVerifiedGatewayListenerPidsOnPortSync,
  formatGatewayPidList: (pids: number[]) => pids.join(", "),
}));

// mock-isolation: Record startup options without starting a Gateway.
vi.mock("../../gateway/server.js", () => ({ startGatewayServer: mocks.startGatewayServer }));

vi.mock("../../daemon/launchd.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/launchd.js")>()),
  parkCurrentLaunchAgentForMaintenance: mocks.parkCurrentLaunchAgentForMaintenance,
}));

// mock-isolation: Keep websocket logging state outside the CLI fixture.
vi.mock("../../gateway/ws-logging.js", () => ({
  setGatewayWsLogStyle: mocks.setGatewayWsLogStyle,
}));

// mock-isolation: Keep verbose-mode changes local to the CLI fixture.
vi.mock("../../globals.js", () => ({ setVerbose: (_enabled: boolean) => undefined }));

vi.mock("../../infra/ports-inspect.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/ports-inspect.js")>()),
  inspectPortUsage: vi.fn(async () => ({ status: "free" })),
}));

vi.mock("../../infra/ports-format.js", () => ({ formatPortDiagnostics: () => [] }));

vi.mock("../../infra/supervisor-markers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/supervisor-markers.js")>();
  return {
    ...actual,
    detectRespawnSupervisor: mocks.detectRespawnSupervisor,
  };
});

// mock-isolation: Capture console setup without changing process-wide logging.
vi.mock("../../logging/console.js", () => ({
  setConsoleSubsystemFilter: mocks.setConsoleSubsystemFilter,
  setConsoleTimestampPrefix: () => undefined,
}));

// mock-isolation: Record bundle requests without writing diagnostic artifacts.
vi.mock("../../logging/diagnostic-stability-bundle.js", () => ({
  writeDiagnosticStabilityBundleForFailureSync,
}));

// mock-isolation: Keep boot history and its database workers outside the CLI fixture.
vi.mock("../../infra/gateway-boot-lifecycle.js", () => ({
  GATEWAY_CRASH_LOOP_BREAKER_REASON: "gateway.crash_loop_breaker",
  formatGatewayCrashLoopManualChannelStartHint: () => bootLifecycle.manualChannelStartHint,
  beginGatewayBootLifecycle: (env?: NodeJS.ProcessEnv, nowMs?: number) =>
    bootLifecycle.begin(env, nowMs),
  inspectGatewayCrashLoopBreakerAsync: async (env?: NodeJS.ProcessEnv, nowMs?: number) =>
    bootLifecycle.inspect(env, nowMs),
  recordGatewayCrashLoopRecovery: bootLifecycle.recover,
  completeGatewayBootLifecycle: bootLifecycle.complete,
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

// mock-isolation: Control terminal admission without reading the host TTY.
vi.mock("../terminal-interactivity.js", () => ({
  isTerminalInteractive: mocks.isTerminalInteractive,
  NON_INTERACTIVE_GATEWAY_RUN_FORCE_MESSAGE:
    "Refusing to kill the operator's running gateway service from a non-interactive shell. Use an isolated dev gateway (openclaw gateway run --dev, or --profile <name> with a free port) for testing.",
}));

// mock-isolation: Control repair prompts without modifying operator config.
vi.mock("../invalid-config-recovery.js", () => ({
  offerInvalidConfigRecovery: mocks.offerInvalidConfigRecovery,
}));

// mock-isolation: Keep live port diagnostics outside CLI option tests.
vi.mock("../ports.js", () => ({
  forceFreePortAndWait: mocks.forceFreePortAndWait,
  waitForPortBindable: mocks.waitForPortBindable,
}));

// mock-isolation: Record development setup without writing Gateway config.
vi.mock("./dev.js", () => ({ ensureDevGatewayConfig: mocks.ensureDevGatewayConfig }));

// mock-isolation: Control lifecycle callbacks without entering a live Gateway loop.
vi.mock("./run-loop.js", () => ({ runGatewayLoop: mocks.runGatewayLoop }));

describe("gateway run option collisions", () => {
  let addGatewayRunCommand: typeof import("./run-command.js").addGatewayRunCommand;
  let sharedProgram: Command;

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
    vi.clearAllMocks();
    resetRuntimeCapture();
    configState.cfg = {};
    configState.snapshot = { config: {}, exists: false, sourceConfig: {}, valid: true };
    netState.autoBindHost = "127.0.0.1";
    netState.container = false;
    detectRespawnSupervisor.mockReset().mockReturnValue(null);
    gatewayLogMessages.length = 0;
    gatewayErrorMessages.length = 0;
    bootLifecycle.decisions.length = 0;
    findVerifiedGatewayListenerPidsOnPortSync.mockReset().mockReturnValue([]);
    isTerminalInteractive.mockReset().mockReturnValue(true);
    parkCurrentLaunchAgentForMaintenance.mockReset().mockResolvedValue(false);
    warnAboutGatewayRestartStorm.mockReset();
    normalizeStateDirEnv.mockReset();
    loadGlobalRuntimeDotEnvFiles.mockReset();
    shouldDeferShellEnvFallback.mockReset().mockReturnValue(false);
    shouldEnableShellEnvFallback.mockReset().mockReturnValue(false);
  });

  function runtimeSnapshot(
    config: Record<string, unknown> = {},
    overrides: Record<string, unknown> = {},
  ) {
    return {
      config,
      sourceConfig: config,
      exists: true,
      valid: true,
      ...overrides,
    };
  }

  const configSnapshot = (
    config: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
  ) => runtimeSnapshot(config, { path: "/tmp/openclaw.json", ...overrides });

  function localConfig(envVars?: Record<string, string>) {
    return { gateway: { mode: "local" }, ...(envVars ? { env: { vars: envVars } } : {}) };
  }

  const bootstrapParams = { opts: {}, runtime: defaultRuntime };
  async function selectAndPrepareConfig() {
    const { selectGatewayRunEnvironment, prepareGatewayRunBootstrap } =
      await import("./pre-bootstrap.js");
    expect(await selectGatewayRunEnvironment(bootstrapParams)).toBe(true);
    expect(await prepareGatewayRunBootstrap(bootstrapParams)).toBe(true);
  }

  async function runGatewayCli(argv: string[]) {
    await sharedProgram.parseAsync(argv, { from: "user" });
  }

  const runUnconfigured = (...args: string[]) =>
    runGatewayCli(["gateway", "run", "--allow-unconfigured", ...args]);
  const expectExit = (code: number, ...args: string[]) =>
    expect(runUnconfigured(...args)).rejects.toThrow(`__exit__:${code}`);

  async function prepareGatewayReset() {
    const { prepareGatewayRunBootstrap } = await import("./pre-bootstrap.js");
    return await prepareGatewayRunBootstrap({ opts: { reset: true }, runtime: defaultRuntime });
  }

  registerInvalidConfigResetTests(configState);
  function callArg(mock: { mock: { calls: unknown[][] } }, index = 0, argIndex = 0): unknown {
    const call = mock.mock.calls[index];
    if (!call) {
      throw new Error(`Expected mock call ${index}`);
    }
    return call[argIndex];
  }

  function gatewayStartOptions(index = 0) {
    expect(startGatewayServer.mock.calls[index]?.[0]).toBe(18789);
    return callArg(startGatewayServer, index, 1) as GatewayServerOptions;
  }

  const callOrder = (mock: { mock: { invocationCallOrder: number[] } }, index = 0) =>
    mock.mock.invocationCallOrder[index] ?? 0;

  registerGatewayRunCleanupReceiptTests({ runGatewayCli, runGatewayLoop });

  it("allows ambient channel triggers with the deprecated alias", async () => {
    await runUnconfigured("--dev-ambient-channels");

    expect(gatewayStartOptions().ambientEnvTriggers).toBe("allow");
  });

  it.each([false, true])("prepares shell env fallback (%s)", async (changed) => {
    await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: undefined }, async () => {
      const finalConfig = {
        env: {
          shellEnv: { enabled: true, timeoutMs: 1234 },
          vars: { OPENCLAW_GATEWAY_TOKEN: "config-token" },
        },
        gateway: {
          auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" },
          mode: "local",
        },
        proxy: { enabled: true, proxyUrl: "http://127.0.0.1:29876" },
      };
      configState.snapshot = configSnapshot(finalConfig, { parsed: finalConfig });
      let startupSnapshot = configState.snapshot;
      readConfigFileSnapshotWithPluginMetadata.mockImplementationOnce(async (options) => {
        expect(options?.lowerPrecedenceEnv).toBeUndefined();
        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
        return { snapshot: startupSnapshot };
      });
      loadShellEnvFallback.mockImplementationOnce(() => {
        if (changed) {
          process.env.OPENCLAW_GATEWAY_TOKEN = "shell-token";
          readConfigFileSnapshotWithPluginMetadata.mockImplementationOnce(async (options) => {
            expect(options?.lowerPrecedenceEnv).toEqual({
              OPENCLAW_GATEWAY_TOKEN: "shell-token",
            });
            expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("shell-token");
            startupSnapshot = {
              ...configState.snapshot,
              config: {
                ...finalConfig,
                gateway: { mode: "local", auth: { mode: "token", token: "config-token" } },
              },
            };
            return { snapshot: startupSnapshot };
          });
        }
      });
      const uninstall = installGatewayRunRuntimeHooks({ refreshManagedProxy });
      try {
        await runGatewayCli(["gateway"]);
      } finally {
        uninstall();
      }

      expect(loadShellEnvFallback).toHaveBeenCalledWith({
        env: process.env,
        expectedKeys: ["OPENCLAW_GATEWAY_TOKEN"],
        logger: expect.any(Object),
        timeoutMs: 1234,
      });
      expect(readConfigFileSnapshotWithPluginMetadata).toHaveBeenCalledTimes(changed ? 2 : 1);
      expect(gatewayStartOptions().startupConfigSnapshotRead?.snapshot).toEqual(startupSnapshot);
      expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("config-token");
      const shellOrder = callOrder(loadShellEnvFallback);
      expect(shellOrder).toBeGreaterThan(callOrder(readConfigFileSnapshotWithPluginMetadata));
      if (changed) {
        expect(clearShellEnvAppliedKeys).toHaveBeenCalledWith(["OPENCLAW_GATEWAY_TOKEN"]);
        expect(callOrder(readConfigFileSnapshotWithPluginMetadata, 1)).toBeGreaterThan(shellOrder);
      }
      expect(callOrder(refreshManagedProxy)).toBeGreaterThan(shellOrder);
      expect(callOrder(startGatewayServer)).toBeGreaterThan(callOrder(refreshManagedProxy));
    });
  });

  it("ignores shell fallback controls from invalid config", async () => {
    const { clearGatewayRunConfigEnvironment } = await import("./pre-bootstrap.js");
    clearGatewayRunConfigEnvironment();
    await withEnvAsync(
      {
        OPENCLAW_DEFER_SHELL_ENV_FALLBACK: undefined,
        OPENCLAW_LOAD_SHELL_ENV: "1",
      },
      async () => {
        const invalidConfig = {
          env: { vars: { OPENCLAW_DEFER_SHELL_ENV_FALLBACK: "1" } },
          gateway: { mode: "local" },
        };
        configState.snapshot = configSnapshot(invalidConfig, {
          issues: [{ path: "gateway", message: "invalid" }],
          parsed: invalidConfig,
          valid: false,
        });
        shouldEnableShellEnvFallback.mockImplementation(
          (env?: NodeJS.ProcessEnv) => env?.OPENCLAW_LOAD_SHELL_ENV === "1",
        );
        shouldDeferShellEnvFallback.mockImplementation(
          (env?: NodeJS.ProcessEnv) => env?.OPENCLAW_DEFER_SHELL_ENV_FALLBACK === "1",
        );

        await runGatewayCli(["gateway", "--allow-unconfigured"]);

        expect(loadShellEnvFallback).toHaveBeenCalledOnce();
        expect(startGatewayServer).toHaveBeenCalledOnce();
      },
    );
  });

  it("leaves legacy config environment inactive and requires fresh selection after repair", async () => {
    const selectedStateDir = "/tmp/openclaw-stable-upgrade-state";
    await withEnvAsync({ OPENCLAW_STATE_DIR: undefined }, async () => {
      const stableConfig: OpenClawConfig = {
        meta: { lastTouchedVersion: "2026.7.1-2" },
        env: { vars: { OPENCLAW_STATE_DIR: selectedStateDir } },
        gateway: { mode: "local" },
      };
      configState.snapshot = completeSnapshot(stableConfig, {
        issues: [{ path: "meta", message: "retired" }],
        legacyIssues: [{ path: "", message: "retired" }],
        valid: false,
      });
      const { recheckGatewayRunBootstrap } = await import("./pre-bootstrap.js");
      await selectAndPrepareConfig();
      expect(process.env.OPENCLAW_STATE_DIR).toBeUndefined();

      const repairedConfig = {
        env: stableConfig.env,
        gateway: { mode: "local" as const },
        meta: { lastTouchedVersion: VERSION },
      } satisfies ConfigFileSnapshot["sourceConfig"];
      const repairedSnapshot = completeSnapshot(repairedConfig);
      await expect(
        recheckGatewayRunBootstrap({ ...bootstrapParams, snapshot: repairedSnapshot }),
      ).rejects.toMatchObject({ code: 1 });
      configState.snapshot = repairedSnapshot;
      await selectAndPrepareConfig();
      expect(process.env.OPENCLAW_STATE_DIR).toBe(selectedStateDir);
      expect(
        await recheckGatewayRunBootstrap({ ...bootstrapParams, snapshot: repairedSnapshot }),
      ).toBe(true);
      await expect(
        recheckGatewayRunBootstrap({
          ...bootstrapParams,
          snapshot: {
            ...repairedSnapshot,
            sourceConfig: { ...repairedConfig, gateway: { mode: "remote" } },
          },
        }),
      ).rejects.toMatchObject({ code: 1 });
    });
  });

  it("rejects an invalid final config after a prepared config selected runtime paths", async () => {
    const selectedStateDir = "/tmp/openclaw-prepared-selected-state";
    await withEnvAsync({ OPENCLAW_STATE_DIR: undefined }, async () => {
      const selectedConfig = localConfig({ OPENCLAW_STATE_DIR: selectedStateDir });
      configState.snapshot = configSnapshot(selectedConfig, { parsed: selectedConfig });
      const { applyFinalGatewayRunConfigEnv } = await import("./pre-bootstrap.js");
      await selectAndPrepareConfig();
      expect(process.env.OPENCLAW_STATE_DIR).toBe(selectedStateDir);

      const invalidSnapshot = {
        ...configState.snapshot,
        issues: [{ message: "invalid", path: "gateway" }],
        valid: false,
      };
      await expect(
        applyFinalGatewayRunConfigEnv({
          runtime: defaultRuntime,
          snapshot: invalidSnapshot as ConfigFileSnapshot,
        }),
      ).rejects.toThrow("__exit__:1");

      expect(runtimeErrors.join("\n")).toContain("final config read became invalid");
      expect(startGatewayServer).not.toHaveBeenCalled();
    });
  });

  it("rereads changed config and replaces its env", async () => {
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_PROXY_URL: undefined,
        OPENCLAW_RAW_STREAM: undefined,
      },
      async () => {
        const oldConfig = localConfig({
          OPENCLAW_GATEWAY_TOKEN: "old-token",
          OPENCLAW_PROXY_URL: "http://127.0.0.1:19876",
          OPENCLAW_RAW_STREAM: "1",
        });
        const newConfig = localConfig({ OPENCLAW_GATEWAY_TOKEN: "new-token" });
        configState.snapshot = configSnapshot(oldConfig, { hash: "old" });
        await selectAndPrepareConfig();
        expect(pinRuntimePaths).toHaveBeenCalledWith(process.env);
        expect(pinConfigDir).toHaveBeenCalledWith(process.env);
        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("old-token");
        expect(process.env.OPENCLAW_PROXY_URL).toBe("http://127.0.0.1:19876");

        configState.snapshot = configSnapshot(newConfig, { hash: "new" });
        readConfigFileSnapshotWithPluginMetadata.mockImplementationOnce(async () => {
          expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
          expect(process.env.OPENCLAW_PROXY_URL).toBeUndefined();
          return { snapshot: configState.snapshot };
        });
        await runGatewayCli(["gateway", "--raw-stream"]);

        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("new-token");
        expect(process.env.OPENCLAW_PROXY_URL).toBeUndefined();
        expect(process.env.OPENCLAW_RAW_STREAM).toBe("1");
      },
    );
  });

  it("forwards parent-captured options to `gateway run` subcommand", async () => {
    await runGatewayCli([
      "gateway",
      "--ambient-channels",
      "run",
      "--token",
      "tok_run",
      "--bind",
      "lan",
      "--allow-unconfigured",
      "--ws-log",
      "full",
      "--force",
    ]);

    expect(callArg(forceFreePortAndWait, 0, 0)).toBe(18789);
    expect(callArg(waitForPortBindable, 0, 0)).toBe(18789);
    expect(setGatewayWsLogStyle).toHaveBeenCalledWith("full");
    expect(gatewayStartOptions()).toMatchObject({
      auth: { token: "tok_run" },
      bind: "lan",
      ambientEnvTriggers: "allow",
    });
    expect(normalizeStateDirEnv).toHaveBeenCalledWith(process.env);
  });

  it("refuses non-interactive --force when a verified gateway appears before signaling", async () => {
    isTerminalInteractive.mockReturnValue(false);
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValueOnce([]).mockReturnValueOnce([4242]);
    forceFreePortAndWait.mockImplementationOnce(async (_port, opts) => {
      (opts as { beforeSignal?: () => void }).beforeSignal?.();
      return { killed: [], waitedMs: 0, escalatedToSigkill: false };
    });

    await expectExit(1, "--force");

    expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(18789);
    expect(forceFreePortAndWait).toHaveBeenCalledTimes(1);
    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("openclaw gateway run --dev");
    expect(runtimeErrors.join("\n")).toContain("--profile <name> with a free port");
  });

  it("reports restart storms before managed macOS Gateway startup", async () => {
    const warning = "Gateway restart storm: inspect launchd jobs with openclaw gateway status.";
    warnAboutGatewayRestartStorm.mockImplementation(async (_env, warn) => warn(warning));
    startGatewayServer.mockImplementationOnce(async () => {
      expect(gatewayLogMessages).toContain(warning);
      return { close: vi.fn(async () => {}) };
    });
    await withMockedPlatform("darwin", () =>
      withEnvAsync(
        {
          OPENCLAW_SERVICE_MARKER: "openclaw",
          [GATEWAY_SERVICE_RUNTIME_PID_ENV]: "4242",
        },
        async () => {
          await runUnconfigured();

          expect(cleanStaleGatewayProcessesSync).toHaveBeenCalledWith(18789, {
            protectedPid: 4242,
          });
          expect(process.env[GATEWAY_SERVICE_RUNTIME_PID_ENV]).toBe(String(process.pid));
        },
      ),
    );
    expect(startGatewayServer).toHaveBeenCalledTimes(1);
  });

  it("rechecks future config after the final config enters service mode", async () => {
    await withEnvAsync(
      {
        OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: "1",
        OPENCLAW_SERVICE_MARKER: undefined,
      },
      async () => {
        const finalConfig = {
          env: { vars: { OPENCLAW_SERVICE_MARKER: "openclaw" } },
          gateway: { mode: "local" },
          meta: { lastTouchedVersion: "9999.1.1" },
        };
        configState.cfg = finalConfig;
        configState.snapshot = configSnapshot(finalConfig);

        await expect(runGatewayCli(["gateway"])).rejects.toThrow("__exit__:78");

        expect(process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS).toBeUndefined();
        expect(process.env.OPENCLAW_SERVICE_MARKER).toBeUndefined();
        expect(startGatewayServer).not.toHaveBeenCalled();
        expect(runtimeErrors.join("\n")).toContain("start the gateway service");
      },
    );
  });

  it.each([
    ["--force", 1, "force-kill gateway port listeners"],
    ["service", 78, "start the gateway service"],
  ] as const)("blocks %s from an older binary with newer config", async (mode, code, action) => {
    configState.snapshot = runtimeSnapshot({ meta: { lastTouchedVersion: "9999.1.1" } });

    await withEnvAsync(
      { OPENCLAW_SERVICE_MARKER: mode === "service" ? "gateway" : undefined },
      () => expectExit(code, ...(mode === "service" ? [] : [mode])),
    );
    expect(forceFreePortAndWait).not.toHaveBeenCalled();
    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain(`Refusing to ${action}`);
  });

  it("blocks dev reset when parseable future-version metadata is schema-invalid", async () => {
    configState.snapshot = {
      config: {},
      exists: true,
      issues: [{ message: "unknown newer field", path: "gateway.newerField" }],
      parsed: { gateway: { newerField: true }, meta: { lastTouchedVersion: "9999.1.1" } },
      sourceConfig: {
        gateway: { newerField: true },
        meta: { lastTouchedVersion: "9999.1.1" },
      },
      valid: false,
    };

    await expect(prepareGatewayReset()).rejects.toThrow("__exit__:1");

    expect(ensureDevGatewayConfig).not.toHaveBeenCalled();
    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("Refusing to reset the dev gateway state");
  });

  it("does not retain targets or credentials from the config deleted by dev reset", async () => {
    await withEnvAsync(
      {
        OPENCLAW_CONFIG_PATH: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_HOME: undefined,
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_STATE_DIR: undefined,
        OPENCLAW_WORKSPACE_DIR: undefined,
      },
      async () => {
        configState.snapshot = runtimeSnapshot(localConfig(), {
          sourceConfig: localConfig({
            OPENCLAW_CONFIG_PATH: "/tmp/openclaw-reset/openclaw.json",
            OPENCLAW_GATEWAY_TOKEN: "old-token",
            OPENCLAW_HOME: "/tmp/openclaw-reset-home",
            OPENCLAW_STATE_DIR: "/tmp/openclaw-reset",
          }),
        });
        ensureDevGatewayConfig.mockImplementationOnce(async () => {
          expect(process.env.OPENCLAW_CONFIG_PATH).toBeUndefined();
          expect(process.env.OPENCLAW_HOME).toBeUndefined();
          expect(process.env.OPENCLAW_PROFILE).toBe("dev");
          expect(process.env.OPENCLAW_STATE_DIR).toBeUndefined();
          expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
          expect(process.env.OPENCLAW_WORKSPACE_DIR).toBe("/tmp/openclaw-reset-workspace");
          configState.snapshot = runtimeSnapshot(localConfig());
        });
        loadGlobalRuntimeDotEnvFiles.mockImplementation(() => {
          process.env.OPENCLAW_GATEWAY_TOKEN ??= "trusted-token";
          process.env.OPENCLAW_PROFILE ??= "dev";
          if (process.env.OPENCLAW_WORKSPACE_DIR === undefined) {
            setTestEnvValue("OPENCLAW_WORKSPACE_DIR", "/tmp/openclaw-reset-workspace");
          }
        });

        await prepareGatewayReset();
        await runUnconfigured("--dev", "--reset");

        expect(ensureDevGatewayConfig).toHaveBeenCalledWith({ reset: true });
        expect(gatewayStartOptions().ambientEnvTriggers).toBe("suppress");
        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("trusted-token");
        expect(loadGlobalRuntimeDotEnvFiles).toHaveBeenCalled();
      },
    );
  });

  it("refuses dev reset if trusted dotenv retargets after pre-bootstrap", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: "/tmp/openclaw-reset-original" }, async () => {
      configState.snapshot = configSnapshot(
        { gateway: { mode: "local" } },
        { path: "/tmp/openclaw-reset-original/openclaw.json" },
      );
      await prepareGatewayReset();
      loadGlobalRuntimeDotEnvFiles.mockImplementation(() => {
        setTestEnvValue("OPENCLAW_STATE_DIR", "/tmp/openclaw-reset-retargeted");
        return {
          dotenvPresentKeys: ["OPENCLAW_STATE_DIR"],
          gatewayEnvAppliedKeys: [],
          stateEnvAppliedKeys: ["OPENCLAW_STATE_DIR"],
        };
      });

      await expectExit(1, "--dev", "--reset");

      expect(ensureDevGatewayConfig).not.toHaveBeenCalled();
      expect(process.env.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-reset-original");
      expect(runtimeErrors.join("\n")).toContain(
        "selected config or state target changed during startup",
      );
    });
  });

  it("blocks trusted dotenv selector drift after startup mutations", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: "/tmp/openclaw-reset-value" }, async () => {
      loadGlobalRuntimeDotEnvFiles.mockImplementation(() => {
        setTestEnvValue("OPENCLAW_STATE_DIR", "/tmp/openclaw-reset-retargeted");
      });
      const { reloadTrustedGatewayRunEnvironment } = await import("./pre-bootstrap.js");
      await expect(reloadTrustedGatewayRunEnvironment({ runtime: defaultRuntime })).rejects.toThrow(
        "__exit__:1",
      );
      expect(process.env.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-reset-value");
      expect(runtimeErrors.join("\n")).toContain(
        "trusted dotenv reload after startup mutations changed config or state selection",
      );
    });
  });

  it.each([false, true])(
    "blocks final config selector drift with prior selection=%s",
    async (selected) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: undefined }, async () => {
        if (selected) {
          const guardedConfig = localConfig({ OPENCLAW_STATE_DIR: "/tmp/openclaw-guarded-state" });
          configState.snapshot = configSnapshot(guardedConfig, { hash: "guarded" });
          await selectAndPrepareConfig();
          expect(process.env.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-guarded-state");
        }
        const finalConfig = localConfig({
          OPENCLAW_STATE_DIR: selected
            ? "/tmp/openclaw-final-state"
            : "/tmp/openclaw-late-selection",
        });
        configState.snapshot = selected
          ? configSnapshot(finalConfig, { hash: "final" })
          : runtimeSnapshot(localConfig(), { sourceConfig: finalConfig });
        await expect(runGatewayCli(["gateway", "run"])).rejects.toThrow("__exit__:1");
        expect(process.env.OPENCLAW_STATE_DIR).toBe(
          selected ? "/tmp/openclaw-guarded-state" : undefined,
        );
        expect(startGatewayServer).not.toHaveBeenCalled();
        expect(runtimeErrors.join("\n")).toContain(
          "final config read changed config or state selection",
        );
      });
    },
  );

  it("enables CLI backend log filtering", async () => {
    delete process.env.OPENCLAW_CLI_BACKEND_LOG_OUTPUT;
    await runUnconfigured("--cli-backend-logs");
    expect(setConsoleSubsystemFilter).toHaveBeenCalledWith(["agent/cli-backend"]);
    expect(process.env.OPENCLAW_CLI_BACKEND_LOG_OUTPUT).toBe("1");
  });

  it.each(["auto", "lan"])("blocks %s startup without explicit gateway auth", async (bind) => {
    if (bind === "auto") {
      netState.autoBindHost = "0.0.0.0";
      netState.container = true;
    }
    await withEnvAsync(withoutGatewayAuthEnv, () =>
      expectExit(78, ...(bind === "auto" ? [] : ["--bind", "lan"])),
    );
    expect(runtimeErrors.join("\n")).toContain(`Refusing to bind gateway to ${bind} without auth.`);
    expect(startGatewayServer).not.toHaveBeenCalled();
  });

  it("refreshes config and crash-loop state for each boot iteration", async () => {
    let firstBootRecovery: GatewayServerOptions["tryRecoverChannelAutostartSuppression"];
    bootLifecycle.nextBootId.mockReturnValueOnce("boot-1").mockReturnValueOnce("boot-2");
    runGatewayLoop.mockImplementationOnce(async ({ beginBoot, start }: GatewayLoopParams) => {
      await beginBoot?.(1000);
      await start({ startupStartedAt: 1000 });
      firstBootRecovery = gatewayStartOptions(0).tryRecoverChannelAutostartSuppression;
      await beginBoot?.(2000);
      await start({ startupStartedAt: 2000 });
    });
    bootLifecycle.decisions.push(bootDecision(true), bootDecision(false, true));

    await runUnconfigured();

    expect(bootLifecycle.inspect).toHaveBeenCalledTimes(2);
    expect(bootLifecycle.inspect.mock.calls.map((call) => call[1])).toEqual([1000, 2000]);
    expect(bootLifecycle.begin.mock.calls.map((call) => call[1])).toEqual([1000, 2000]);
    expect(writeDiagnosticStabilityBundleForFailureSync).toHaveBeenCalledTimes(1);
    expect(gatewayStartOptions(0).channelAutostartSuppression).toMatchObject({
      reason: "crash-loop-breaker",
    });
    expect(gatewayStartOptions(0).channelAutostartSuppression?.message).toContain(
      bootLifecycle.manualChannelStartHint,
    );
    expect(gatewayStartOptions(1).channelAutostartSuppression).toBeUndefined();
    expect(startGatewayServer).toHaveBeenCalledTimes(2);
    expect(gatewayStartOptions(0).startupStartedAt).toBe(1000);
    expect(gatewayStartOptions(0).startupConfigSnapshotRead).toEqual({
      snapshot: configState.snapshot,
    });
    expect(gatewayStartOptions(1).startupConfigSnapshotRead).toBeUndefined();
    expect(gatewayStartOptions(1).startupStartedAt).toBe(2000);
    bootLifecycle.decisions.push(bootDecision(false, true));
    await expect(firstBootRecovery?.(new AbortController().signal)).rejects.toThrow(
      "replaced boot",
    );
    expect(bootLifecycle.inspect).toHaveBeenCalledTimes(2);
    expect(bootLifecycle.recover).not.toHaveBeenCalled();
    expect(gatewayLogMessages.some((message) => message.includes("breaker recovered"))).toBe(true);
  });

  it.each([
    { supervised: false, transition: false, recorded: true, attempts: 1 },
    { supervised: true, transition: false, recorded: true, attempts: 0 },
    { supervised: true, transition: true, recorded: true, attempts: 0, cleanupFailure: "wrapped" },
  ])(
    "triages failed starts once with supervisor transition gating: %j",
    async ({ supervised, transition, recorded, attempts, cleanupFailure }) => {
      triageAfterFailure.mockClear();
      detectRespawnSupervisor.mockReturnValue(supervised ? "systemd" : null);
      bootLifecycle.nextBootId.mockReturnValueOnce(recorded ? "boot-id" : undefined);
      bootLifecycle.decisions.push(bootDecision(transition));
      let failure: Error = new Error("configured plugin crashed during startup");
      if (cleanupFailure) {
        const { GatewayStartupCleanupError } = await import("../../gateway/server-shutdown.js");
        failure = new GatewayStartupCleanupError(
          failure,
          new Error("required cleanup unconfirmed"),
        );
        if (cleanupFailure === "wrapped") {
          failure = new Error("startup wrapper failed", { cause: failure });
        }
      }
      runGatewayLoop.mockImplementationOnce(async (params: GatewayLoopParams) => {
        await params.beginBoot?.(1000);
        // Repeated in-process failures and the terminal catch share one handoff.
        await params.onRestartStartupFailure?.(failure, new AbortController().signal);
        await params.onRestartStartupFailure?.(failure, new AbortController().signal);
        throw failure;
      });
      await expectExit(1);
      expect(triageAfterFailure).toHaveBeenCalledTimes(attempts);
      if (attempts) {
        expect(triageAfterFailure).toHaveBeenCalledWith(
          defaultRuntime,
          expect.objectContaining({
            kind: "gateway-startup",
            error: failure.message,
            gateway: "verify-running",
          }),
          expect.any(AbortSignal),
        );
      }
      expect(runtimeErrors.join("\n")).toContain(failure.message);
    },
  );

  it("retains the actual legacy-session refusal without triage on restart", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-legacy-refusal-"));
    const storePath = path.join(root, "sessions.json");
    const original = '{"main":{"sessionId":"legacy","updatedAt":1}}';
    await fs.writeFile(storePath, original);
    try {
      const { assertSessionStoreMigrationComplete } =
        await import("../../config/sessions/startup-migration.js");
      let refusal: unknown;
      try {
        assertSessionStoreMigrationComplete({ cfg: {}, targets: [{ storePath }] });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(Error);
      const message = (refusal as Error).message;
      expect(message).toBe(
        `Legacy session store requires migration: ${storePath}. Run "openclaw doctor --fix" against the same state/config before starting OpenClaw.`,
      );
      const failure = refusal;
      runGatewayLoop.mockImplementationOnce(async (params: GatewayLoopParams) => {
        await params.beginBoot?.(1000);
        await params.onRestartStartupFailure?.(failure, new AbortController().signal);
        throw failure;
      });
      await withEnvAsync({ CODEX_THREAD_ID: undefined }, async () => {
        await expectExit(78);
      });
      expect(triageAfterFailure).not.toHaveBeenCalled();
      expect(parkCurrentLaunchAgentForMaintenance).toHaveBeenCalledOnce();
      expect(runtimeErrors.join("\n")).toContain(message);
      expect(await fs.readFile(storePath, "utf8")).toBe(original);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  registerGatewayLockFailureTests({
    ...mocks,
    expectExit,
    configState,
    withoutSupervisorEnv,
    runtimeErrors,
    writeDiagnosticStabilityBundleForFailureSync,
  });

  it("exits 78 and parks launchd for a repairable shared-state schema", async () => {
    bootLifecycle.nextBootId.mockReturnValueOnce(undefined);
    runGatewayLoop.mockImplementationOnce(async ({ start, completeBoot }: GatewayLoopParams) => {
      try {
        await start();
      } catch (error) {
        completeBoot?.({ outcome: "startup_failed", reason: "schema migration required" });
        throw error;
      }
    });
    startGatewayServer.mockRejectedValueOnce(
      new OpenClawStateDatabaseSchemaMigrationRequiredError(
        "audit-events-v2",
        "/tmp/openclaw.sqlite",
      ),
    );
    parkCurrentLaunchAgentForMaintenance.mockResolvedValueOnce(true);

    await expectExit(78);

    expect(parkCurrentLaunchAgentForMaintenance).toHaveBeenCalledOnce();
    expect(bootLifecycle.complete).toHaveBeenCalledWith(
      undefined,
      {
        outcome: "startup_failed",
        reason: "schema migration required",
      },
      process.env,
    );
    expect(triageAfterFailure).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain(
      "state database schema migration required (audit-events-v2)",
    );
  });

  it.each([
    { phase: "server", kind: "state" },
    { phase: "bootstrap", kind: "reader" },
  ] as const)("stops newer-schema retries from $phase ($kind)", async ({ phase, kind }) => {
    const readerError = createNewerSqliteSchemaVersionError(
      "test database",
      "/tmp/newer.sqlite",
      999,
      998,
    );
    const error =
      kind === "state"
        ? new OpenClawDatabaseSchemaPreflightError([
            {
              kind,
              path: "/tmp/newer.sqlite",
              foundVersion: 999,
              supportedVersion: 998,
              writerAppVersion: "2026.9.4",
            },
          ])
        : readerError;
    if (phase === "bootstrap") {
      beforeRun.mockRejectedValueOnce(error);
    } else {
      startGatewayServer.mockRejectedValueOnce(error);
    }
    parkCurrentLaunchAgentForMaintenance.mockResolvedValueOnce(true);
    const restoreHooks = installGatewayRunRuntimeHooks({ refreshManagedProxy });
    try {
      await expectExit(78);
    } finally {
      restoreHooks();
    }

    expect(parkCurrentLaunchAgentForMaintenance).toHaveBeenCalledOnce();
    expect(offerInvalidConfigRecovery).not.toHaveBeenCalled();
    if (error instanceof OpenClawDatabaseSchemaPreflightError) {
      expect(gatewayErrorMessages).toEqual([`${error.message} Parked the managed LaunchAgent.`]);
      expect(gatewayErrorMessages[0]).toContain(
        "uses schema 999; this build supports 998; writer build 2026.9.4",
      );
      expect(runtimeErrors).toEqual([`Gateway failed to start: ${error.message}`]);
    } else {
      expect(runtimeErrors.join("\n")).toContain("newer");
      expect(runtimeErrors.join("\n")).toContain("restore your pre-update backup");
      expect(runtimeErrors.join("\n")).toMatch(
        /Stop the service.*then restore your pre-update backup created with openclaw backup create, then start it again/s,
      );
    }
    expect(triageAfterFailure).not.toHaveBeenCalled();
    expect(startGatewayServer).toHaveBeenCalledTimes(phase === "server" ? 1 : 0);
  });

  it("blocks invalid config without automatic recovery", async () => {
    configState.snapshot = failedGatewayRunConfigSnapshot();
    await expect(runGatewayCli(["gateway", "run"])).rejects.toThrow("__exit__:78");
    expect(runtimeErrors).toContain(
      "Gateway start blocked: existing config is missing gateway.mode. Treat this as suspicious or clobbered config. Re-run `openclaw onboard --mode local` or `openclaw setup`, set gateway.mode=local manually, or pass --allow-unconfigured.",
    );
    expect(runtimeErrors).toContain(`Config write audit: ${CONFIG_AUDIT_STORE_LABEL}`);
    expect(readConfigFileSnapshotWithPluginMetadata).toHaveBeenCalledOnce();
    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(readBestEffortConfig).not.toHaveBeenCalled();
  });

  it.each(gatewayRunReadFailures())("preserves $label", async (fixture) => {
    if (fixture.stage === "runtime") {
      const config: OpenClawConfig = { gateway: { mode: "local", auth: { mode: "none" } } };
      configState.snapshot = runtimeSnapshot(config);
      runGatewayLoop.mockImplementationOnce(async ({ start }: GatewayLoopParams) => {
        await start();
        await start();
      });
      startGatewayServer
        .mockResolvedValueOnce({ close: vi.fn(async () => {}) })
        .mockRejectedValueOnce(fixture.failure);
    } else if (fixture.stage === "read") {
      readConfigFileSnapshotWithPluginMetadata.mockRejectedValueOnce(fixture.failure);
    } else {
      readConfigFileSnapshotWithPluginMetadata.mockResolvedValueOnce({
        snapshot: fixture.snapshot,
      });
    }
    const error = await runGatewayCli(["gateway", "run"]).catch((caught: unknown) => caught);
    if (fixture.exact) {
      expect(error).toBe(fixture.expected);
    } else {
      expect(error).toMatchObject(fixture.expected);
    }
    expect(startGatewayServer).toHaveBeenCalledTimes(fixture.stage === "runtime" ? 2 : 0);
    expect(offerInvalidConfigRecovery).not.toHaveBeenCalled();
  });

  it("does not offer doctor repair after --allow-unconfigured reaches startup", async () => {
    const { createInvalidConfigError } = await import("../../config/io.invalid-config.js");
    startGatewayServer.mockRejectedValueOnce(
      createInvalidConfigError("/tmp/openclaw.json", "gateway.mode: invalid"),
    );

    await expectExit(78);

    expect(offerInvalidConfigRecovery).not.toHaveBeenCalled();
    expect(startGatewayServer).toHaveBeenCalledOnce();
  });

  it("prints all supported modes on invalid --auth value", async () => {
    await expectExit(1, "--auth", "bad-mode");

    expect(runtimeErrors).toContain(
      'Invalid --auth. Use "none", "token", "password", or "trusted-proxy".',
    );
  });

  it("allows password mode preflight when password is configured via SecretRef", async () => {
    configState.cfg = {
      gateway: {
        auth: {
          mode: "password",
          password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
        },
      },
      secrets: { defaults: { env: "default" } },
    };
    configState.snapshot = {
      exists: true,
      valid: true,
      config: configState.cfg,
      parsed: configState.cfg,
    };

    await runUnconfigured();

    expect(gatewayStartOptions().bind).toBe("loopback");
  });

  it("reads gateway password from --password-file", async () => {
    await withTempSecretFiles(
      "openclaw-gateway-run-",
      { password: "pw_from_file\n" },
      async ({ passwordFile }) => {
        await runUnconfigured("--auth", "password", "--password-file", passwordFile ?? "");
      },
    );

    const options = gatewayStartOptions();
    expect(options.auth?.mode).toBe("password");
    expect(options.auth?.password).toBe("pw_from_file"); // pragma: allowlist secret
    expect(runtimeErrors).not.toContain(
      "Warning: --password can be exposed via process listings. Prefer --password-file or OPENCLAW_GATEWAY_PASSWORD.",
    );
  });

  it("warns when gateway password is passed inline", async () => {
    await runUnconfigured("--auth", "password", "--password", "pw_inline");

    expect(runtimeErrors).toContain(
      "Warning: --password can be exposed via process listings. Prefer --password-file or OPENCLAW_GATEWAY_PASSWORD.",
    );
  });

  it("rejects using both --password and --password-file", async () => {
    await withTempSecretFiles(
      "openclaw-gateway-run-",
      { password: "pw_from_file\n" },
      async ({ passwordFile }) => {
        await expectExit(1, "--password", "pw_inline", "--password-file", passwordFile ?? "");
      },
    );
    expect(runtimeErrors[0]).toContain("Use either --password or --password-file.");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
