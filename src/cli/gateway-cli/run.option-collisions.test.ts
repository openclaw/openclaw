import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_AUDIT_STORE_LABEL } from "../../config/io.audit.js";
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
import { getFreePort } from "../../test-utils/ports.js";
import { withTempSecretFiles } from "../../test-utils/secret-file-fixture.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import { VERSION } from "../../version.js";
import { createCliRuntimeCapture } from "../test-runtime-capture.js";
import {
  failedGatewayRunConfigSnapshot,
  gatewayRunReadFailures,
  type RuntimeDotEnvLoadResult,
} from "./run-config.test-support.js";
import { installGatewayRunRuntimeHooks } from "./runtime-hooks.js";

const startGatewayServer = vi.fn(async (_port: number, _opts?: unknown) => ({
  close: vi.fn(async () => {}),
}));
const triageAfterFailure = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../commands/triage-failure.js", () => ({ triageAfterFailure }));
const setGatewayWsLogStyle = vi.fn((_style: string) => undefined);
const setVerbose = vi.fn((_enabled: boolean) => undefined);
const setConsoleSubsystemFilter = vi.fn((_filters: string[]) => undefined);
const forceFreePortAndWait = vi.fn(async (_port: number, _opts: unknown) => ({
  killed: [],
  waitedMs: 0,
  escalatedToSigkill: false,
}));
const cleanStaleGatewayProcessesSync = vi.fn(
  (_port?: number, _options?: { protectedPid?: number }) => [],
);
const warnAboutGatewayRestartStorm = vi.fn(
  async (_env: NodeJS.ProcessEnv, _warn: (message: string) => void) => {},
);
const waitForPortBindable = vi.fn(async (_port: number, _opts?: unknown) => 0);
const findVerifiedGatewayListenerPidsOnPortSync = vi.fn((_port: number) => [] as number[]);
const formatGatewayPidList = vi.fn((pids: number[]) => pids.join(", "));
const isTerminalInteractive = vi.fn(() => true);
const offerInvalidConfigRecovery = vi.fn(async () => ({ status: "declined" as const }));
const parkCurrentLaunchAgentForMaintenance = vi.fn(async () => false);
const ensureDevGatewayConfig = vi.fn(async (_opts?: unknown) => {});
type GatewayLoopStart = (params?: { startupStartedAt?: number }) => Promise<unknown>;
type GatewayLoopParams = {
  start: GatewayLoopStart;
  beginBoot?: (startedAtMs: number) => Promise<void> | void;
  completeBoot?: (completion: unknown) => void;
  onRestartStartupFailure?: (error: unknown, signal: AbortSignal) => Promise<void>;
  ownsProcessLifecycle?: boolean;
  runtime?: unknown;
};
const runGatewayLoop = vi.fn(async ({ start }: GatewayLoopParams) => {
  await start();
});
const normalizeStateDirEnv = vi.fn((_env?: NodeJS.ProcessEnv) => undefined);
const pinConfigDir = vi.fn((_env?: NodeJS.ProcessEnv) => undefined);
const pinRuntimePaths = vi.fn((_env?: NodeJS.ProcessEnv) => undefined);
const detectRespawnSupervisor = vi.fn(() => null as "systemd" | null);
const loadGlobalRuntimeDotEnvFiles = vi.fn<
  (_opts?: unknown) => RuntimeDotEnvLoadResult | undefined
>(() => undefined);
const beforeRun = vi.fn(async () => {});
const refreshManagedProxy = vi.fn(async () => {});
const loadShellEnvFallback = vi.fn((_opts?: unknown) => {});
const clearShellEnvAppliedKeys = vi.fn((_keys: readonly string[]) => undefined);
const resolveShellEnvExpectedKeys = vi.fn((_env?: NodeJS.ProcessEnv, _config?: OpenClawConfig) => [
  "OPENCLAW_GATEWAY_TOKEN",
]);
const resolveShellEnvFallbackTimeoutMs = vi.fn((_env?: NodeJS.ProcessEnv) => 15_000);
const shouldDeferShellEnvFallback = vi.fn((_env?: NodeJS.ProcessEnv) => false);
const shouldEnableShellEnvFallback = vi.fn((_env?: NodeJS.ProcessEnv) => false);
const gatewayLogMessages = vi.hoisted(() => [] as string[]);
const gatewayErrorMessages = vi.hoisted(() => [] as string[]);
const configState = vi.hoisted(() => ({
  cfg: {} as Record<string, unknown>,
  snapshot: { config: {}, exists: false, sourceConfig: {}, valid: true } as Record<string, unknown>,
}));
const readBestEffortConfig = vi.fn(async () => configState.cfg);
type ConfigSnapshotReadOptionsStub = {
  isolateEnv?: boolean;
  lowerPrecedenceEnv?: Readonly<Record<string, string>>;
  observe?: boolean;
};
const readConfigFileSnapshotWithPluginMetadata = vi.fn(
  async (_options?: ConfigSnapshotReadOptionsStub) => ({
    snapshot: configState.snapshot,
  }),
);
const writeDiagnosticStabilityBundleForFailureSync = vi.fn((_reason: string, _error: unknown) => ({
  status: "written" as const,
  message: "wrote stability bundle: /tmp/openclaw-stability.json",
  path: "/tmp/openclaw-stability.json",
}));
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

vi.mock("../../config/config.js", () => ({
  getConfigPath: () => "/tmp/openclaw-test-missing-config.json",
  readBestEffortConfig: () => readBestEffortConfig(),
  readConfigFileSnapshot: async () => configState.snapshot,
  readConfigFileSnapshotWithPluginMetadata: (options?: ConfigSnapshotReadOptionsStub) =>
    readConfigFileSnapshotWithPluginMetadata(options),
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

// mock-isolation: Keep boot history and its database workers outside the CLI fixture.
vi.mock("../../infra/gateway-boot-lifecycle.js", () => ({
  GATEWAY_CRASH_LOOP_BREAKER_REASON: "gateway.crash_loop_breaker",
  formatGatewayCrashLoopManualChannelStartHint: () => bootLifecycle.manualChannelStartHint,
  GATEWAY_CRASH_LOOP_RECOVERED_REASON: "gateway.crash_loop_recovered",
  inspectGatewayCrashLoopBreaker: (env?: NodeJS.ProcessEnv, nowMs?: number) =>
    bootLifecycle.inspect(env, nowMs),
  inspectGatewayCrashLoopBreakerAsync: async (env?: NodeJS.ProcessEnv, nowMs?: number) =>
    bootLifecycle.inspect(env, nowMs),
  recordGatewayBootStart: (env?: NodeJS.ProcessEnv, nowMs?: number, reason?: string) =>
    bootLifecycle.record(env, nowMs, reason),
  recordGatewayCrashLoopRecovery: (
    bootId?: string,
    env?: NodeJS.ProcessEnv,
    nowMs?: number,
    assertCurrent?: () => void,
  ) => bootLifecycle.recover(bootId, env, nowMs, assertCurrent),
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
    findVerifiedGatewayListenerPidsOnPortSync.mockReset();
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
    isTerminalInteractive.mockReset();
    isTerminalInteractive.mockReturnValue(true);
    parkCurrentLaunchAgentForMaintenance.mockReset();
    parkCurrentLaunchAgentForMaintenance.mockResolvedValue(false);
    warnAboutGatewayRestartStorm.mockReset();
    normalizeStateDirEnv.mockReset();
    loadGlobalRuntimeDotEnvFiles.mockReset();
    shouldDeferShellEnvFallback.mockReset();
    shouldDeferShellEnvFallback.mockReturnValue(false);
    shouldEnableShellEnvFallback.mockReset();
    shouldEnableShellEnvFallback.mockReturnValue(false);
  });

  function configSnapshot(
    config: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      config,
      sourceConfig: config,
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      ...overrides,
    };
  }

  async function runGatewayCli(argv: string[]) {
    await sharedProgram.parseAsync(argv, { from: "user" });
  }

  async function prepareGatewayReset() {
    const { prepareGatewayRunBootstrap } = await import("./pre-bootstrap.js");
    return await prepareGatewayRunBootstrap({ opts: { reset: true }, runtime: defaultRuntime });
  }

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

  it("rejects invalid gateway ports before startup", async () => {
    await expect(
      runGatewayCli(["gateway", "--port", "0", "--token", "test-token"]),
    ).rejects.toThrow("__exit__:1");

    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("Invalid --port. Use a port number from 1 to 65535");
  });

  it("suppresses ambient channel triggers by default in dev mode", async () => {
    await runGatewayCli(["gateway", "run", "--allow-unconfigured", "--dev"]);
    expect(gatewayStartOptions().ambientEnvTriggers).toBe("suppress");
  });

  it.each([
    {
      label: "the inherited primary flag",
      argv: ["gateway", "--ambient-channels", "run", "--allow-unconfigured"],
    },
    {
      label: "the deprecated alias",
      argv: ["gateway", "run", "--allow-unconfigured", "--dev-ambient-channels"],
    },
  ])("allows ambient channel triggers with $label", async ({ argv }) => {
    await runGatewayCli(argv);

    expect(gatewayStartOptions().ambientEnvTriggers).toBe("allow");
  });

  it("loads configured shell env fallback before final proxy refresh and gateway startup", async () => {
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
      readConfigFileSnapshotWithPluginMetadata
        .mockImplementationOnce(async (options) => {
          expect(options?.lowerPrecedenceEnv).toBeUndefined();
          expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
          return { snapshot: configState.snapshot };
        })
        .mockImplementationOnce(async (options) => {
          expect(options?.lowerPrecedenceEnv).toEqual({
            OPENCLAW_GATEWAY_TOKEN: "shell-token",
          });
          expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("shell-token");
          return {
            snapshot: {
              ...configState.snapshot,
              config: {
                ...finalConfig,
                gateway: {
                  ...finalConfig.gateway,
                  auth: { mode: "token", token: "config-token" },
                },
              },
            },
          };
        });
      loadShellEnvFallback.mockImplementationOnce((opts?: unknown) => {
        (opts as { env: NodeJS.ProcessEnv }).env.OPENCLAW_GATEWAY_TOKEN = "shell-token";
      });
      const uninstall = installGatewayRunRuntimeHooks({ refreshManagedProxy });
      try {
        await runGatewayCli(["gateway"]);
      } finally {
        uninstall();
      }

      expect(loadShellEnvFallback).toHaveBeenCalledWith({
        enabled: true,
        env: process.env,
        expectedKeys: ["OPENCLAW_GATEWAY_TOKEN"],
        logger: expect.any(Object),
        timeoutMs: 1234,
      });
      expect(resolveShellEnvExpectedKeys).toHaveBeenCalledWith(
        expect.objectContaining({ OPENCLAW_GATEWAY_TOKEN: "config-token" }),
        finalConfig,
      );
      expect(readConfigFileSnapshotWithPluginMetadata).toHaveBeenCalledTimes(2);
      expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("config-token");
      expect(clearShellEnvAppliedKeys).toHaveBeenCalledWith(["OPENCLAW_GATEWAY_TOKEN"]);
      const shellEnvOrder = loadShellEnvFallback.mock.invocationCallOrder[0] ?? 0;
      const initialConfigReadOrder =
        readConfigFileSnapshotWithPluginMetadata.mock.invocationCallOrder[0] ?? 0;
      const finalConfigReadOrder =
        readConfigFileSnapshotWithPluginMetadata.mock.invocationCallOrder[1] ?? 0;
      const refreshOrder = refreshManagedProxy.mock.invocationCallOrder[0] ?? 0;
      const startOrder = startGatewayServer.mock.invocationCallOrder[0] ?? 0;
      expect(shellEnvOrder).toBeGreaterThan(initialConfigReadOrder);
      expect(finalConfigReadOrder).toBeGreaterThan(shellEnvOrder);
      expect(refreshOrder).toBeGreaterThan(shellEnvOrder);
      expect(startOrder).toBeGreaterThan(refreshOrder);
    });
  });

  it("removes shell fallback values when the final accepted config disables fallback", async () => {
    await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: undefined }, async () => {
      const enabledConfig = {
        env: { shellEnv: { enabled: true } },
        gateway: { auth: { mode: "none" }, mode: "local" },
      };
      const disabledConfig = {
        gateway: { auth: { mode: "none" }, mode: "local" },
      };
      const snapshot = (config: Record<string, unknown>) =>
        configSnapshot(config, { parsed: config });
      readConfigFileSnapshotWithPluginMetadata
        .mockResolvedValueOnce({ snapshot: snapshot(enabledConfig) })
        .mockImplementationOnce(async (options) => {
          expect(options?.lowerPrecedenceEnv).toEqual({
            OPENCLAW_GATEWAY_TOKEN: "shell-token",
          });
          expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("shell-token");
          return { snapshot: snapshot(disabledConfig) };
        })
        .mockImplementationOnce(async (options) => {
          expect(options?.lowerPrecedenceEnv).toBeUndefined();
          expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
          return { snapshot: snapshot(disabledConfig) };
        });
      loadShellEnvFallback.mockImplementationOnce((opts?: unknown) => {
        (opts as { env: NodeJS.ProcessEnv }).env.OPENCLAW_GATEWAY_TOKEN = "shell-token";
      });

      await runGatewayCli(["gateway"]);

      expect(readConfigFileSnapshotWithPluginMetadata).toHaveBeenCalledTimes(3);
      expect(loadShellEnvFallback).toHaveBeenCalledOnce();
      expect(clearShellEnvAppliedKeys).toHaveBeenCalledWith(["OPENCLAW_GATEWAY_TOKEN"]);
      expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
      expect(startGatewayServer).toHaveBeenCalledOnce();
    });
  });

  it("honors config env shell fallback deferral", async () => {
    await withEnvAsync(
      {
        OPENCLAW_DEFER_SHELL_ENV_FALLBACK: undefined,
        OPENCLAW_LOAD_SHELL_ENV: undefined,
      },
      async () => {
        const finalConfig = {
          env: {
            vars: {
              OPENCLAW_DEFER_SHELL_ENV_FALLBACK: "1",
              OPENCLAW_LOAD_SHELL_ENV: "1",
            },
          },
          gateway: { auth: { mode: "none" }, mode: "local" },
        };
        configState.snapshot = configSnapshot(finalConfig, { parsed: finalConfig });
        shouldEnableShellEnvFallback.mockImplementationOnce(
          (env?: NodeJS.ProcessEnv) => env?.OPENCLAW_LOAD_SHELL_ENV === "1",
        );
        shouldDeferShellEnvFallback.mockImplementationOnce(
          (env?: NodeJS.ProcessEnv) => env?.OPENCLAW_DEFER_SHELL_ENV_FALLBACK === "1",
        );

        await runGatewayCli(["gateway"]);

        expect(resolveShellEnvExpectedKeys).not.toHaveBeenCalled();
        expect(loadShellEnvFallback).not.toHaveBeenCalled();
      },
    );
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
        configState.snapshot = {
          config: invalidConfig,
          exists: true,
          issues: [{ path: "gateway", message: "invalid" }],
          parsed: invalidConfig,
          path: "/tmp/openclaw.json",
          sourceConfig: invalidConfig,
          valid: false,
        };
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
      const stableConfig = {
        meta: {
          lastTouchedAt: "2026-08-01T00:00:00.000Z",
          lastTouchedVersion: "2026.7.1-2",
        },
        agents: {
          defaults: { heartbeat: { skipWhenBusy: true } },
          entries: { main: {} },
        },
        env: { vars: { OPENCLAW_STATE_DIR: selectedStateDir } },
        gateway: { mode: "local" },
        session: { idleMinutes: 45 },
      };
      configState.snapshot = {
        config: stableConfig,
        runtimeConfig: stableConfig,
        exists: true,
        issues: [
          { path: "meta", message: "retired" },
          { path: "agents.defaults.heartbeat", message: "retired" },
          { path: "session.idleMinutes", message: "retired" },
        ],
        legacyIssues: [{ path: "", message: "retired" }],
        parsed: stableConfig,
        path: "/tmp/openclaw.json",
        raw: JSON.stringify(stableConfig),
        resolved: stableConfig,
        sourceConfig: stableConfig,
        valid: false,
        warnings: [],
      };
      const {
        prepareGatewayRunBootstrap,
        recheckGatewayRunBootstrap,
        selectGatewayRunEnvironment,
      } = await import("./pre-bootstrap.js");

      expect(await selectGatewayRunEnvironment({ opts: {}, runtime: defaultRuntime })).toBe(true);
      expect(await prepareGatewayRunBootstrap({ opts: {}, runtime: defaultRuntime })).toBe(true);
      expect(process.env.OPENCLAW_STATE_DIR).toBeUndefined();

      const repairedConfig = {
        agents: { defaults: {}, entries: { main: {} } },
        env: stableConfig.env,
        gateway: { mode: "local" as const },
        session: { reset: { mode: "idle", idleMinutes: 45 } },
        meta: {
          lastTouchedVersion: VERSION,
          migrations: { modelPolicyAllowlist: true, utilityModelSeparation: true },
        },
      } satisfies ConfigFileSnapshot["sourceConfig"];
      const repairedSnapshot = {
        config: repairedConfig,
        exists: true,
        issues: [],
        legacyIssues: [],
        parsed: repairedConfig,
        path: "/tmp/openclaw.json",
        raw: JSON.stringify(repairedConfig),
        resolved: repairedConfig,
        runtimeConfig: repairedConfig,
        sourceConfig: repairedConfig,
        valid: true,
        warnings: [],
      } satisfies ConfigFileSnapshot;
      await expect(
        recheckGatewayRunBootstrap({
          opts: {},
          runtime: defaultRuntime,
          snapshot: repairedSnapshot,
        }),
      ).rejects.toMatchObject({ code: 1 });
      configState.snapshot = repairedSnapshot;
      expect(await selectGatewayRunEnvironment({ opts: {}, runtime: defaultRuntime })).toBe(true);
      expect(await prepareGatewayRunBootstrap({ opts: {}, runtime: defaultRuntime })).toBe(true);
      expect(process.env.OPENCLAW_STATE_DIR).toBe(selectedStateDir);
      expect(
        await recheckGatewayRunBootstrap({
          opts: {},
          runtime: defaultRuntime,
          snapshot: repairedSnapshot,
        }),
      ).toBe(true);
      await expect(
        recheckGatewayRunBootstrap({
          opts: {},
          runtime: defaultRuntime,
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
      const selectedConfig = {
        env: { vars: { OPENCLAW_STATE_DIR: selectedStateDir } },
        gateway: { mode: "local" },
      };
      configState.snapshot = configSnapshot(selectedConfig, { parsed: selectedConfig });
      const {
        applyFinalGatewayRunConfigEnv,
        prepareGatewayRunBootstrap,
        selectGatewayRunEnvironment,
      } = await import("./pre-bootstrap.js");

      expect(await selectGatewayRunEnvironment({ opts: {}, runtime: defaultRuntime })).toBe(true);
      expect(await prepareGatewayRunBootstrap({ opts: {}, runtime: defaultRuntime })).toBe(true);
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

  it("replaces config-derived env when the final startup snapshot changes in place", async () => {
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_PROXY_URL: undefined,
        OPENCLAW_RAW_STREAM: undefined,
      },
      async () => {
        const oldConfig = {
          env: {
            vars: {
              OPENCLAW_GATEWAY_TOKEN: "old-token",
              OPENCLAW_PROXY_URL: "http://127.0.0.1:19876",
              OPENCLAW_RAW_STREAM: "1",
            },
          },
          gateway: { mode: "local" },
        };
        const newConfig = {
          env: { vars: { OPENCLAW_GATEWAY_TOKEN: "new-token" } },
          gateway: { mode: "local" },
        };
        configState.snapshot = configSnapshot(oldConfig, { hash: "old" });
        const { prepareGatewayRunBootstrap, selectGatewayRunEnvironment } =
          await import("./pre-bootstrap.js");
        await selectGatewayRunEnvironment({ opts: {}, runtime: defaultRuntime });
        await prepareGatewayRunBootstrap({ opts: {}, runtime: defaultRuntime });
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
      "run",
      "--token",
      "tok_run",
      "--allow-unconfigured",
      "--ws-log",
      "full",
      "--force",
    ]);

    expect(callArg(forceFreePortAndWait, 0, 0)).toBe(18789);
    expect(callArg(waitForPortBindable, 0, 0)).toBe(18789);
    expect(setGatewayWsLogStyle).toHaveBeenCalledWith("full");
    expect(gatewayStartOptions().auth?.token).toBe("tok_run");
    expect(normalizeStateDirEnv).toHaveBeenCalledWith(process.env);
  });

  it("refuses non-interactive --force when a verified gateway appears before signaling", async () => {
    isTerminalInteractive.mockReturnValue(false);
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValueOnce([]).mockReturnValueOnce([4242]);
    forceFreePortAndWait.mockImplementationOnce(async (_port, opts) => {
      (opts as { beforeSignal?: () => void }).beforeSignal?.();
      return { killed: [], waitedMs: 0, escalatedToSigkill: false };
    });

    await expect(
      runGatewayCli(["gateway", "run", "--allow-unconfigured", "--force"]),
    ).rejects.toThrow("__exit__:1");

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
      withEnvAsync({ OPENCLAW_SERVICE_MARKER: "openclaw" }, async () => {
        await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);
      }),
    );
    expect(startGatewayServer).toHaveBeenCalledTimes(1);
  });

  it("protects the inherited service pid before replacing it", async () => {
    await withEnvAsync(
      {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        [GATEWAY_SERVICE_RUNTIME_PID_ENV]: "4242",
      },
      async () => {
        await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);

        expect(cleanStaleGatewayProcessesSync).toHaveBeenCalledWith(18789, {
          protectedPid: 4242,
        });
        expect(process.env[GATEWAY_SERVICE_RUNTIME_PID_ENV]).toBe(String(process.pid));
      },
    );
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

  it("blocks --force port cleanup from an older binary with newer config", async () => {
    configState.snapshot = {
      exists: true,
      valid: true,
      config: { meta: { lastTouchedVersion: "9999.1.1" } },
      sourceConfig: { meta: { lastTouchedVersion: "9999.1.1" } },
    };

    await expect(
      runGatewayCli(["gateway", "run", "--allow-unconfigured", "--force"]),
    ).rejects.toThrow("__exit__:1");

    expect(forceFreePortAndWait).not.toHaveBeenCalled();
    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("Refusing to force-kill gateway port listeners");
  });

  it("blocks service-mode startup from an older binary with newer config", async () => {
    configState.snapshot = {
      exists: true,
      valid: true,
      config: { meta: { lastTouchedVersion: "9999.1.1" } },
      sourceConfig: { meta: { lastTouchedVersion: "9999.1.1" } },
    };
    const previousMarker = process.env.OPENCLAW_SERVICE_MARKER;
    process.env.OPENCLAW_SERVICE_MARKER = "gateway";
    try {
      await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
        "__exit__:78",
      );
    } finally {
      if (previousMarker === undefined) {
        delete process.env.OPENCLAW_SERVICE_MARKER;
      } else {
        process.env.OPENCLAW_SERVICE_MARKER = previousMarker;
      }
    }

    expect(forceFreePortAndWait).not.toHaveBeenCalled();
    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("Refusing to start the gateway service");
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
        configState.snapshot = {
          exists: true,
          valid: true,
          config: { gateway: { mode: "local" } },
          sourceConfig: {
            env: {
              vars: {
                OPENCLAW_CONFIG_PATH: "/tmp/openclaw-reset/openclaw.json",
                OPENCLAW_GATEWAY_TOKEN: "old-token",
                OPENCLAW_HOME: "/tmp/openclaw-reset-home",
                OPENCLAW_STATE_DIR: "/tmp/openclaw-reset",
              },
            },
            gateway: { mode: "local" },
          },
        };
        ensureDevGatewayConfig.mockImplementationOnce(async () => {
          expect(process.env.OPENCLAW_CONFIG_PATH).toBeUndefined();
          expect(process.env.OPENCLAW_HOME).toBeUndefined();
          expect(process.env.OPENCLAW_PROFILE).toBe("dev");
          expect(process.env.OPENCLAW_STATE_DIR).toBeUndefined();
          expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
          expect(process.env.OPENCLAW_WORKSPACE_DIR).toBe("/tmp/openclaw-reset-workspace");
          configState.snapshot = {
            exists: true,
            valid: true,
            config: { gateway: { mode: "local" } },
            sourceConfig: { gateway: { mode: "local" } },
          };
        });
        loadGlobalRuntimeDotEnvFiles.mockImplementation(() => {
          process.env.OPENCLAW_GATEWAY_TOKEN ??= "trusted-token";
          process.env.OPENCLAW_PROFILE ??= "dev";
          if (process.env.OPENCLAW_WORKSPACE_DIR === undefined) {
            setTestEnvValue("OPENCLAW_WORKSPACE_DIR", "/tmp/openclaw-reset-workspace");
          }
        });

        await prepareGatewayReset();
        await runGatewayCli(["gateway", "run", "--allow-unconfigured", "--dev", "--reset"]);

        expect(ensureDevGatewayConfig).toHaveBeenCalledWith({ reset: true });
        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("trusted-token");
        expect(loadGlobalRuntimeDotEnvFiles).toHaveBeenCalled();
      },
    );
  });

  it("refuses dev reset if trusted dotenv retargets after pre-bootstrap", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: "/tmp/openclaw-reset-original" }, async () => {
      configState.snapshot = {
        config: { gateway: { mode: "local" } },
        exists: true,
        path: "/tmp/openclaw-reset-original/openclaw.json",
        sourceConfig: { gateway: { mode: "local" } },
        valid: true,
      };
      await prepareGatewayReset();
      loadGlobalRuntimeDotEnvFiles.mockImplementation(() => {
        setTestEnvValue("OPENCLAW_STATE_DIR", "/tmp/openclaw-reset-retargeted");
        return {
          dotenvPresentKeys: ["OPENCLAW_STATE_DIR"],
          gatewayEnvAppliedKeys: [],
          stateEnvAppliedKeys: ["OPENCLAW_STATE_DIR"],
        };
      });

      await expect(
        runGatewayCli(["gateway", "run", "--allow-unconfigured", "--dev", "--reset"]),
      ).rejects.toThrow("__exit__:1");

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

  it("blocks a final startup snapshot that changes guarded config selection", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: undefined }, async () => {
      configState.snapshot = {
        exists: true,
        valid: true,
        config: { gateway: { mode: "local" } },
        sourceConfig: {
          env: { vars: { OPENCLAW_STATE_DIR: "/tmp/openclaw-late-selection" } },
          gateway: { mode: "local" },
        },
      };

      await expect(runGatewayCli(["gateway", "run"])).rejects.toThrow("__exit__:1");

      expect(process.env.OPENCLAW_STATE_DIR).toBeUndefined();
      expect(startGatewayServer).not.toHaveBeenCalled();
      expect(runtimeErrors.join("\n")).toContain(
        "final config read changed config or state selection",
      );
    });
  });

  it("blocks a final startup snapshot that changes an already-selected config selector", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: undefined }, async () => {
      const guardedConfig = {
        env: { vars: { OPENCLAW_STATE_DIR: "/tmp/openclaw-guarded-state" } },
        gateway: { mode: "local" },
      };
      configState.snapshot = configSnapshot(guardedConfig, { hash: "guarded" });
      const { prepareGatewayRunBootstrap, selectGatewayRunEnvironment } =
        await import("./pre-bootstrap.js");
      await selectGatewayRunEnvironment({ opts: {}, runtime: defaultRuntime });
      await prepareGatewayRunBootstrap({ opts: {}, runtime: defaultRuntime });
      expect(process.env.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-guarded-state");

      const finalConfig = {
        env: { vars: { OPENCLAW_STATE_DIR: "/tmp/openclaw-final-state" } },
        gateway: { mode: "local" },
      };
      configState.snapshot = configSnapshot(finalConfig, { hash: "final" });

      await expect(runGatewayCli(["gateway", "run"])).rejects.toThrow("__exit__:1");

      expect(process.env.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-guarded-state");
      expect(startGatewayServer).not.toHaveBeenCalled();
      expect(runtimeErrors.join("\n")).toContain(
        "final config read changed config or state selection",
      );
    });
  });

  it("enables CLI backend log filtering", async () => {
    delete process.env.OPENCLAW_CLI_BACKEND_LOG_OUTPUT;
    await runGatewayCli(["gateway", "run", "--cli-backend-logs", "--allow-unconfigured"]);
    expect(setConsoleSubsystemFilter).toHaveBeenCalledWith(["agent/cli-backend"]);
    expect(process.env.OPENCLAW_CLI_BACKEND_LOG_OUTPUT).toBe("1");
  });

  it("blocks container auto startup without explicit gateway auth", async () => {
    netState.autoBindHost = "0.0.0.0";
    netState.container = true;

    await withEnvAsync(withoutGatewayAuthEnv, async () => {
      await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
        "__exit__:78",
      );
    });

    expect(runtimeErrors.join("\n")).toContain("Refusing to bind gateway to auto without auth.");
    expect(startGatewayServer).not.toHaveBeenCalled();
  });

  it("blocks non-loopback startup without explicit gateway auth", async () => {
    await withEnvAsync(withoutGatewayAuthEnv, async () => {
      await expect(
        runGatewayCli(["gateway", "run", "--bind", "lan", "--allow-unconfigured"]),
      ).rejects.toThrow("__exit__:78");
    });

    expect(runtimeErrors.join("\n")).toContain("Refusing to bind gateway to lan without auth.");
    expect(startGatewayServer).not.toHaveBeenCalled();
  });

  it("allows non-loopback startup when token auth is explicit", async () => {
    await runGatewayCli([
      "gateway",
      "run",
      "--bind",
      "lan",
      "--token",
      "tok_run",
      "--allow-unconfigured",
    ]);

    const options = gatewayStartOptions();
    expect(options.bind).toBe("lan");
    expect(options.auth?.token).toBe("tok_run");
  });

  it("leaves service environment unchanged until Doctor repairs invalid config", async () => {
    detectRespawnSupervisor.mockReturnValue("systemd");
    const { createConfigResolutionFacts, setConfigResolutionFacts } =
      await import("../../config/resolution-facts.js");
    const sourceConfig = {
      session: { idleMinutes: 45 },
      env: { vars: { CONFIG_UNTRUSTED_KEY: "must-not-apply" } },
      models: { providers: { minimax: { apiKey: "substituted-not-a-real-key" } } },
    };
    setConfigResolutionFacts(
      sourceConfig,
      createConfigResolutionFacts(
        [],
        new Map(),
        "default",
        new Map([["models.providers.minimax.apiKey", "SHORTHAND_KEY"]]),
      ),
    );
    configState.snapshot = {
      path: "/tmp/openclaw.json",
      includedPaths: [],
      exists: true,
      raw: JSON.stringify(sourceConfig),
      parsed: sourceConfig,
      config: sourceConfig,
      sourceConfig,
      valid: false,
      issues: [{ path: "session.idleMinutes", message: "retired" }],
      legacyIssues: [{ path: "", message: "retired" }],
    };
    loadGlobalRuntimeDotEnvFiles.mockReturnValue({
      dotenvPresentKeys: [],
      gatewayEnvAppliedKeys: [],
      stateEnvAppliedKeys: [],
    });

    await withMockedPlatform("linux", () =>
      withEnvAsync(
        {
          INVOCATION_ID: "systemd-invocation",
          OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "SHORTHAND_KEY,REMOVED_KEY",
          SHORTHAND_KEY: "environment-file-value",
          REMOVED_KEY: "stale-service-value",
          CONFIG_UNTRUSTED_KEY: undefined,
        },
        async () => {
          const { selectGatewayRunEnvironment } = await import("./pre-bootstrap.js");
          expect(await selectGatewayRunEnvironment({ opts: {}, runtime: defaultRuntime })).toBe(
            true,
          );
          expect(process.env.SHORTHAND_KEY).toBe("environment-file-value");
          expect(process.env.REMOVED_KEY).toBe("stale-service-value");
          expect(process.env.CONFIG_UNTRUSTED_KEY).toBeUndefined();
        },
      ),
    );
  });

  it("refreshes config and crash-loop state for each boot iteration", async () => {
    let firstBootRecovery: GatewayServerOptions["tryRecoverChannelAutostartSuppression"];
    bootLifecycle.record.mockReturnValueOnce("boot-1").mockReturnValueOnce("boot-2");
    runGatewayLoop.mockImplementationOnce(async ({ beginBoot, start }: GatewayLoopParams) => {
      await beginBoot?.(1000);
      await start({ startupStartedAt: 1000 });
      firstBootRecovery = gatewayStartOptions(0).tryRecoverChannelAutostartSuppression;
      await beginBoot?.(2000);
      await start({ startupStartedAt: 2000 });
    });
    bootLifecycle.decisions.push(
      {
        tripped: true,
        uncleanBoots: 3,
        windowMs: 300_000,
        shouldWriteStabilityBundle: true,
        recovered: false,
      },
      {
        tripped: false,
        uncleanBoots: 0,
        windowMs: 300_000,
        shouldWriteStabilityBundle: false,
        recovered: true,
      },
    );

    await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);

    expect(bootLifecycle.inspect).toHaveBeenCalledTimes(2);
    expect(bootLifecycle.inspect.mock.calls.map((call) => call[1])).toEqual([1000, 2000]);
    expect(bootLifecycle.record.mock.calls.map((call) => call[2])).toEqual([
      "gateway.crash_loop_breaker",
      "gateway.crash_loop_recovered",
    ]);
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
    bootLifecycle.decisions.push({
      tripped: false,
      uncleanBoots: 0,
      windowMs: 300_000,
      shouldWriteStabilityBundle: false,
      recovered: true,
    });
    await expect(firstBootRecovery?.(new AbortController().signal)).rejects.toThrow(
      "replaced boot",
    );
    expect(bootLifecycle.inspect).toHaveBeenCalledTimes(2);
    expect(bootLifecycle.recover).not.toHaveBeenCalled();
    expect(gatewayLogMessages.some((message) => message.includes("breaker recovered"))).toBe(true);
  });

  it.each([
    { supervised: false, transition: false, recorded: true, attempts: 1 },
    { supervised: false, transition: false, recorded: false, attempts: 0 },
    { supervised: true, transition: false, recorded: true, attempts: 0 },
    { supervised: true, transition: true, recorded: true, attempts: 1 },
    { supervised: true, transition: true, recorded: true, attempts: 0, cleanupFailure: "wrapped" },
  ])(
    "triages failed starts once with supervisor transition gating: %j",
    async ({ supervised, transition, recorded, attempts, cleanupFailure }) => {
      triageAfterFailure.mockClear();
      detectRespawnSupervisor.mockReturnValue(supervised ? "systemd" : null);
      bootLifecycle.record.mockReturnValueOnce(recorded ? "boot-id" : undefined);
      bootLifecycle.decisions.push({
        tripped: transition,
        uncleanBoots: transition ? 3 : 0,
        windowMs: 300_000,
        shouldWriteStabilityBundle: transition,
        recovered: false,
      });
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
      await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
        "__exit__:1",
      );
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
        await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
          "__exit__:78",
        );
      });
      expect(triageAfterFailure).not.toHaveBeenCalled();
      expect(parkCurrentLaunchAgentForMaintenance).toHaveBeenCalledOnce();
      expect(runtimeErrors.join("\n")).toContain(message);
      expect(await fs.readFile(storePath, "utf8")).toBe(original);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("exits 78 when the only startup blocker is legacy workspace setup state", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-workspace-refusal-"));
    const source = path.join(workspaceDir, "openclaw-workspace-state.json");
    const original = JSON.stringify({ version: 1, setupCompletedAt: new Date().toISOString() });
    await fs.writeFile(source, original);
    try {
      const { assertWorkspaceStateMigrationReady } =
        await import("../../agents/workspace-legacy-state.js");
      startGatewayServer.mockImplementationOnce(async () => {
        assertWorkspaceStateMigrationReady({ workspaceDirs: [workspaceDir] });
        throw new Error("Legacy workspace setup state was unexpectedly accepted");
      });
      await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
        "__exit__:78",
      );
      expect(parkCurrentLaunchAgentForMaintenance).toHaveBeenCalledOnce();
      expect(triageAfterFailure).not.toHaveBeenCalled();
      expect(runtimeErrors.join("\n")).toMatch(/gateway stop.*doctor --fix.*gateway start/s);
      expect(await fs.readFile(source, "utf8")).toBe(original);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("skips failure bundles but exits nonzero for unconfirmed gateway lock conflicts", async () => {
    const port = await getFreePort();
    configState.snapshot = {
      config: { gateway: { port } },
      exists: false,
      sourceConfig: {},
      valid: true,
    };
    const err = Object.assign(new Error(`gateway already running on port ${port}`), {
      name: "GatewayLockError",
    });
    startGatewayServer.mockRejectedValueOnce(err);

    await withEnvAsync(withoutSupervisorEnv, async () => {
      await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
        "__exit__:1",
      );
    });

    expect(writeDiagnosticStabilityBundleForFailureSync).not.toHaveBeenCalled();
    expect(startGatewayServer).toHaveBeenCalledWith(port, expect.any(Object));
    expect(runtimeErrors.join("\n")).toContain(`gateway already running on port ${port}`);
    expect(runtimeErrors.join("\n")).toContain("gateway stop");
    expect(triageAfterFailure).not.toHaveBeenCalled();
  });

  it("exits 78 and parks launchd for a repairable shared-state schema", async () => {
    bootLifecycle.record.mockReturnValueOnce(undefined);
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

    await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
      "__exit__:78",
    );

    expect(parkCurrentLaunchAgentForMaintenance).toHaveBeenCalledOnce();
    expect(bootLifecycle.complete).toHaveBeenCalledWith(undefined, {
      outcome: "startup_failed",
      reason: "schema migration required",
    });
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
      await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
        "__exit__:78",
      );
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
      configState.snapshot = { config, exists: true, sourceConfig: config, valid: true };
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

  it.each([false, true])(
    "allows explicit invalid-config startup (dev reset: %s)",
    async (reset) => {
      configState.snapshot = failedGatewayRunConfigSnapshot();
      if (reset) {
        await prepareGatewayReset();
      }
      await runGatewayCli([
        "gateway",
        ...(reset ? ["--dev", "--reset"] : ["run"]),
        "--allow-unconfigured",
      ]);
      if (reset) {
        expect(ensureDevGatewayConfig).toHaveBeenCalledWith({ reset: true });
      } else {
        const options = gatewayStartOptions();
        expect(options.bind).toBe("loopback");
        expect(options.startupConfigSnapshotRead?.snapshot?.valid).toBe(false);
      }
    },
  );

  it("does not offer doctor repair after --allow-unconfigured reaches startup", async () => {
    const { createInvalidConfigError } = await import("../../config/io.invalid-config.js");
    startGatewayServer.mockRejectedValueOnce(
      createInvalidConfigError("/tmp/openclaw.json", "gateway.mode: invalid"),
    );

    await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
      "__exit__:78",
    );

    expect(offerInvalidConfigRecovery).not.toHaveBeenCalled();
    expect(startGatewayServer).toHaveBeenCalledOnce();
  });

  it("prints all supported modes on invalid --auth value", async () => {
    await expect(
      runGatewayCli(["gateway", "run", "--auth", "bad-mode", "--allow-unconfigured"]),
    ).rejects.toThrow("__exit__:1");

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
      secrets: {
        defaults: {
          env: "default",
        },
      },
    };
    configState.snapshot = {
      exists: true,
      valid: true,
      config: configState.cfg,
      parsed: configState.cfg,
    };

    await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);

    expect(gatewayStartOptions().bind).toBe("loopback");
  });

  it("reads gateway password from --password-file", async () => {
    await withTempSecretFiles(
      "openclaw-gateway-run-",
      { password: "pw_from_file\n" },
      async ({ passwordFile }) => {
        await runGatewayCli([
          "gateway",
          "run",
          "--auth",
          "password",
          "--password-file",
          passwordFile ?? "",
          "--allow-unconfigured",
        ]);
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
    await runGatewayCli([
      "gateway",
      "run",
      "--auth",
      "password",
      "--password",
      "pw_inline",
      "--allow-unconfigured",
    ]);

    expect(runtimeErrors).toContain(
      "Warning: --password can be exposed via process listings. Prefer --password-file or OPENCLAW_GATEWAY_PASSWORD.",
    );
  });

  it("rejects using both --password and --password-file", async () => {
    await withTempSecretFiles(
      "openclaw-gateway-run-",
      { password: "pw_from_file\n" },
      async ({ passwordFile }) => {
        await expect(
          runGatewayCli([
            "gateway",
            "run",
            "--password",
            "pw_inline",
            "--password-file",
            passwordFile ?? "",
            "--allow-unconfigured",
          ]),
        ).rejects.toThrow("__exit__:1");
      },
    );
    expect(runtimeErrors[0]).toContain("Use either --password or --password-file.");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
