// Daemon lifecycle tests cover CLI service lifecycle orchestration and cleanup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import { captureEnv } from "../../test-utils/env.js";
import {
  createHealthyRestartSnapshot,
  createDeferredSafeRestartResult,
  createGatewayLockIdentity,
  createGatewayProcessExpectations,
  expectRestartError,
  type RestartHealthSnapshot,
  requireMockCallArg,
  runRestartPostCheck,
  type RestartParams,
} from "./lifecycle.test-helpers.js";

const service = {
  readCommand: vi.fn(),
  readRuntime: vi.fn(),
  restart: vi.fn(),
  stop: vi.fn(),
};

const runServiceStart = vi.fn(),
  runServiceRestart = vi.fn(),
  runServiceStop = vi.fn(),
  runServiceUninstall = vi.fn();
const waitForGatewayHealthyListener = vi.fn(),
  waitForGatewayHealthyRestart = vi.fn();
const terminateStaleGatewayPids = vi.fn();
const renderGatewayPortHealthDiagnostics = vi.fn(() => ["diag: unhealthy port"]);
const renderRestartDiagnostics = vi.fn(() => ["diag: unhealthy runtime"]);
const resolveGatewayPort = vi.hoisted(() => vi.fn((_cfg?: unknown, _env?: unknown) => 18789));
const findVerifiedGatewayListenerPidsOnPortSync = vi.fn<
  typeof import("../../infra/gateway-processes.js").findVerifiedGatewayListenerPidsOnPortSync
>(() => []);
const signalVerifiedGatewayPidSync =
  vi.fn<typeof import("../../infra/gateway-processes.js").signalVerifiedGatewayPidSync>();
const gatewayProcessChecks = createGatewayProcessExpectations(
  findVerifiedGatewayListenerPidsOnPortSync,
  signalVerifiedGatewayPidSync,
);
const writeGatewayRestartIntentSync = vi.fn();
const clearGatewayRestartIntentSync = vi.fn();
const resolveGatewayServiceProbeHosts = vi.fn(
  async (_params: { env?: Record<string, string | undefined>; command?: unknown }) =>
    ["127.0.0.1"] as readonly string[],
);
const probePortUsage = vi.fn(
  async (_port: number, _hosts?: readonly string[]) => "free" as "free" | "busy" | "unknown",
);
const formatGatewayPidList = vi.fn<(pids: number[]) => string>((pids) => pids.join(", "));
const probeGateway =
  vi.fn<
    (opts: {
      url: string;
      auth?: { token?: string; password?: string };
      timeoutMs: number;
    }) => Promise<{ ok: boolean; configSnapshot: unknown }>
  >();
const callGatewayCli = vi.fn();
const loadConfig = vi.hoisted(() => vi.fn(() => ({})));
const createConfigIO = vi.hoisted(() =>
  vi.fn((_opts?: { env?: Record<string, string | undefined>; observe?: boolean }) => ({
    readBestEffortConfig: async () => loadConfig(),
  })),
);
const readActiveGatewayLockPort = vi.hoisted(() => vi.fn<() => Promise<number | undefined>>());
const readGatewayOwnerLease = vi.hoisted(() =>
  vi.fn<typeof import("../../infra/gateway-owner-lease.js").readGatewayOwnerLease>(),
);
type LockIdentity = { pid: number; ownerId?: string; createdAt: string; port: number };
const readActiveGatewayLockIdentity = vi.hoisted(() =>
  vi.fn<() => Promise<LockIdentity | undefined>>(),
);
const recoverInstalledLaunchAgent = vi.hoisted(() => vi.fn());
const repairLoadedGatewayServiceForStart = vi.hoisted(() => vi.fn());
type SystemdScope = { scope: "user" | "system"; unitName: string; unitPath: string };
const findInstalledSystemdGatewayScope = vi.hoisted(() =>
  vi.fn<() => Promise<SystemdScope | null>>(async () => null),
);
const restartSystemdService = vi.hoisted(() =>
  vi.fn<() => Promise<{ outcome: "completed" }>>(async () => ({ outcome: "completed" })),
);
const stopSystemdService = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => {}));
const isTerminalInteractive = vi.fn(() => true);
const appendGatewayLifecycleAudit = vi.fn();
const createGatewayLifecycleMutationAudit = vi.fn(
  (params: { action: string; source?: string }) => (mutation: { mode: string; pid?: number }) =>
    appendGatewayLifecycleAudit({
      action: params.action,
      source: params.source ?? "cli",
      ...mutation,
    }),
);

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => loadConfig(),
  loadConfig: () => loadConfig(),
  readBestEffortConfig: async () => loadConfig(),
  resolveGatewayPort: (cfg?: unknown, env?: unknown) => resolveGatewayPort(cfg, env),
}));

vi.mock("../../config/io.js", () => ({ createConfigIO }));

vi.mock("../../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync,
  signalVerifiedGatewayPidSync,
  formatGatewayPidList: (pids: number[]) => formatGatewayPidList(pids),
}));

vi.mock("../../infra/gateway-lock.js", async (original) => ({
  ...(await original<typeof import("../../infra/gateway-lock.js")>()),
  readActiveGatewayLockPort: () => readActiveGatewayLockPort(),
  readActiveGatewayLockIdentity: () => readActiveGatewayLockIdentity(),
}));

vi.mock("../../infra/gateway-owner-lease.js", () => ({ readGatewayOwnerLease }));

vi.mock("../../infra/restart-intent.js", () => ({
  prepareGatewayRestartIntentLegacyProcess: async () => undefined,
  writeGatewayRestartIntentSync: (params: unknown) => writeGatewayRestartIntentSync(params),
  writeGatewayServiceRestartIntentSync: (params: unknown) => writeGatewayRestartIntentSync(params),
  clearGatewayRestartIntentSync: () => clearGatewayRestartIntentSync(),
}));

vi.mock("../../gateway/probe.js", () => ({ probeGateway }));

vi.mock("../../gateway/call.js", () => ({
  callGatewayCli: (opts: unknown) => callGatewayCli(opts),
}));

vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => service,
}));

vi.mock("../../daemon/systemd.js", () => ({
  findInstalledSystemdGatewayScope: () => findInstalledSystemdGatewayScope(),
  refreshLegacySystemdServiceMetadata: vi.fn(async () => false),
  restartSystemdService: () => restartSystemdService(),
  stopSystemdService: () => stopSystemdService(),
}));
vi.mock("./launchd-recovery.js", () => ({
  recoverInstalledLaunchAgent: (args: { result: "started" | "restarted" }) =>
    recoverInstalledLaunchAgent(args),
}));

vi.mock("./start-repair.js", () => ({
  repairLoadedGatewayServiceForStart: (args: unknown) => repairLoadedGatewayServiceForStart(args),
}));

vi.mock("../terminal-interactivity.js", () => ({
  isTerminalInteractive: () => isTerminalInteractive(),
  NON_INTERACTIVE_GATEWAY_STOP_MESSAGE:
    "This stops the operator's running gateway service. Use an isolated dev gateway (openclaw gateway run --dev, or --profile <name> with a free port) for testing, or re-run with --force if you really mean it.",
}));

vi.mock("./lifecycle-audit.js", () => ({
  appendGatewayLifecycleAudit: (params: unknown) => appendGatewayLifecycleAudit(params),
  createGatewayLifecycleMutationAudit: (params: { action: string; source?: string }) =>
    createGatewayLifecycleMutationAudit(params),
}));

vi.mock("../../daemon/gateway-service-probe-hosts.js", () => ({ resolveGatewayServiceProbeHosts }));

vi.mock("../../infra/ports-probe.js", () => ({ probePortUsage }));

vi.mock("./restart-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./restart-health.js")>()),
  DEFAULT_RESTART_HEALTH_ATTEMPTS: 120,
  DEFAULT_RESTART_HEALTH_DELAY_MS: 500,
  waitForGatewayHealthyListener,
  waitForGatewayHealthyRestart,
  renderGatewayPortHealthDiagnostics,
  terminateStaleGatewayPids,
  renderRestartDiagnostics,
}));

vi.mock("./lifecycle-core.js", () => ({
  runServiceRestart,
  runServiceStart,
  runServiceStop,
  runServiceUninstall,
}));

const { runDaemonStart, runDaemonRestart, runDaemonStop, runDaemonUninstall } =
  await import("./lifecycle.js");

function expectRestartRpc(params: Record<string, unknown>, port?: number, safeTarget = false) {
  expect(callGatewayCli).toHaveBeenCalledWith({
    method: "gateway.restart.request",
    params,
    timeoutMs: 10_000,
    ...(port === undefined ? {} : { localPortOverride: port, ignoreEnvUrlOverride: true }),
    ...(safeTarget ? { requiredCapabilities: ["gateway-restart-target-safe-v1"] } : {}),
  });
}
function expectListenerHealth(
  attempts: number,
  lock = createGatewayLockIdentity(),
  env?: NodeJS.ProcessEnv,
) {
  expect(waitForGatewayHealthyListener).toHaveBeenCalledWith({
    port: lock.port,
    attempts,
    delayMs: 500,
    previousLockIdentity: lock,
    waitIndefinitelyForPreviousOwner: false,
    ...(env ? { env } : {}),
  });
}
const restartTarget = { pid: 4200, ownerId: "gateway-owner-old", port: 18_789 };

describe("runDaemonRestart health checks", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  function mockUnmanagedRestart({
    runPostRestartCheck = false,
  }: {
    runPostRestartCheck?: boolean;
  } = {}) {
    runServiceRestart.mockImplementation(
      async (params: RestartParams & { onNotLoaded?: () => Promise<unknown> }) => {
        const activationAccepted = Boolean(await params.onNotLoaded?.());
        if (runPostRestartCheck) {
          await runRestartPostCheck(params, activationAccepted);
        }
        return true;
      },
    );
  }

  async function runUnmanagedStop(opts: { json?: boolean; force?: boolean } = { json: true }) {
    let outcome: unknown;
    runServiceStop.mockImplementation(
      async (params: {
        onNotLoaded?: (ctx: { stdout: NodeJS.WritableStream }) => Promise<unknown>;
      }) => {
        outcome = await params.onNotLoaded?.({ stdout: process.stdout });
      },
    );
    await runDaemonStop(opts);
    return outcome;
  }

  beforeEach(() => {
    envSnapshot = captureEnv([
      "OPENCLAW_SUPERVISOR_MODE",
      "OPENCLAW_CONTAINER_HINT",
      "OPENCLAW_PROFILE",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_SYSTEMD_UNIT",
    ]);
    delete process.env.OPENCLAW_CONTAINER_HINT;
    delete process.env.OPENCLAW_SUPERVISOR_MODE;
    runServiceUninstall.mockReset();
    service.readCommand.mockReset();
    service.readRuntime.mockReset().mockResolvedValue({ status: "stopped" });
    service.restart.mockReset().mockResolvedValue({ outcome: "completed" });
    service.stop.mockReset();
    runServiceStart.mockReset().mockResolvedValue(undefined);
    runServiceRestart.mockReset();
    runServiceStop.mockReset().mockResolvedValue(undefined);
    waitForGatewayHealthyListener.mockReset();
    waitForGatewayHealthyRestart.mockReset();
    terminateStaleGatewayPids.mockReset();
    renderGatewayPortHealthDiagnostics.mockReset();
    renderRestartDiagnostics.mockReset();
    resolveGatewayPort.mockReset();
    findVerifiedGatewayListenerPidsOnPortSync.mockReset();
    signalVerifiedGatewayPidSync.mockReset().mockImplementation(() => {});
    writeGatewayRestartIntentSync.mockReset().mockReturnValue(true);
    clearGatewayRestartIntentSync.mockReset();
    formatGatewayPidList.mockReset().mockImplementation((pids) => pids.join(", "));
    probeGateway.mockReset();
    callGatewayCli.mockReset();
    loadConfig.mockReset();
    createConfigIO
      .mockReset()
      .mockImplementation(() => ({ readBestEffortConfig: async () => loadConfig() }));
    readActiveGatewayLockPort.mockReset().mockResolvedValue(undefined);
    readGatewayOwnerLease.mockReset().mockReturnValue(undefined);
    readActiveGatewayLockIdentity.mockReset();
    recoverInstalledLaunchAgent.mockReset().mockResolvedValue(null);
    repairLoadedGatewayServiceForStart.mockReset();
    isTerminalInteractive.mockReset().mockReturnValue(true);
    appendGatewayLifecycleAudit.mockClear();
    createGatewayLifecycleMutationAudit.mockClear();
    resolveGatewayServiceProbeHosts.mockReset().mockResolvedValue(["127.0.0.1"]);
    probePortUsage.mockReset().mockResolvedValue("free");
    mockSystemAccountHome();

    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "--port", "18789"],
      environment: {},
    });
    readActiveGatewayLockIdentity.mockResolvedValue(createGatewayLockIdentity());
    findInstalledSystemdGatewayScope.mockReset().mockResolvedValue(null);
    restartSystemdService.mockReset().mockResolvedValue({ outcome: "completed" });
    stopSystemdService.mockReset().mockResolvedValue(undefined);

    runServiceRestart.mockImplementation(async (params: RestartParams) => {
      await runRestartPostCheck(params, true);
      return true;
    });
    waitForGatewayHealthyListener.mockResolvedValue({
      healthy: true,
      portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
    });
    waitForGatewayHealthyRestart.mockResolvedValue(createHealthyRestartSnapshot());
    probeGateway.mockResolvedValue({
      ok: true,
      configSnapshot: { commands: { restart: true } },
    });
    callGatewayCli.mockResolvedValue(createDeferredSafeRestartResult());
  });

  afterEach(() => {
    envSnapshot.restore();
    vi.restoreAllMocks();
  });

  it("re-bootstraps an installed LaunchAgent when start finds it not loaded", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    recoverInstalledLaunchAgent.mockResolvedValue({
      result: "started",
      loaded: true,
      message: "Gateway LaunchAgent was installed but not loaded; re-bootstrapped launchd service.",
    });
    runServiceStart.mockImplementation(async (params: { onNotLoaded?: () => Promise<unknown> }) => {
      await params.onNotLoaded?.();
    });

    await runDaemonStart({ json: true });

    expect(recoverInstalledLaunchAgent).toHaveBeenCalledWith({ result: "started" });
    expect(requireMockCallArg(runServiceStart, "runServiceStart").expectedPort).toBeUndefined();
  });

  it("guards loaded service restart at the native mutation boundary", async () => {
    await runDaemonRestart({ json: true });

    const restartParams = requireMockCallArg(runServiceRestart, "runServiceRestart");
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-non-default-service-state";
    expect(() => (restartParams.beforeServiceMutation as () => void)()).toThrow(
      /non-default state dir/,
    );
  });

  it("re-reads the installed service environment after restart repair", async () => {
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-caller-state";
    process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway-maintenance.service";
    service.readCommand
      .mockResolvedValueOnce({
        programArguments: ["openclaw", "gateway", "--port", "18789"],
        environment: { OPENCLAW_STATE_DIR: "/tmp/openclaw-stale-state" },
      })
      .mockResolvedValue({
        programArguments: ["openclaw", "gateway", "--port", "19001"],
        environment: {
          OPENCLAW_STATE_DIR: "/tmp/openclaw-repaired-state",
          OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service",
        },
      });
    repairLoadedGatewayServiceForStart.mockResolvedValue({
      result: "restarted",
      message: "Gateway service definition repaired and restarted.",
      loaded: true,
    });
    runServiceRestart.mockImplementation(async (params: RestartParams) => {
      await params.repairLoadedService?.({
        json: true,
        stdout: process.stdout,
        state: {},
        issues: [{ code: "port-mismatch", message: "service port is stale" }],
      });
      await runRestartPostCheck(params, false);
      return true;
    });

    await runDaemonRestart({ json: true });

    expect(requireMockCallArg(runServiceRestart, "runServiceRestart").expectedPort).toBeUndefined();
    expect(waitForGatewayHealthyRestart).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 19_001,
        env: expect.objectContaining({
          OPENCLAW_STATE_DIR: "/tmp/openclaw-repaired-state",
          OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-maintenance.service",
        }),
      }),
    );
  });

  it("requests a safe restart without native mutation", async () => {
    await runDaemonRestart({ json: true, safe: true });
    expectRestartRpc({ reason: "gateway.restart.safe" });
    expect(runServiceRestart).not.toHaveBeenCalled();
    expect(appendGatewayLifecycleAudit).toHaveBeenCalledWith({
      action: "restart",
      source: "safe-rpc",
      mode: "deferred",
      pid: 123,
    });
  });

  it("rejects --skip-deferral without --safe", async () => {
    await expect(runDaemonRestart({ json: true, skipDeferral: true })).rejects.toThrow(
      "--skip-deferral requires --safe",
    );
    expect(callGatewayCli).not.toHaveBeenCalled();
    expect(runServiceRestart).not.toHaveBeenCalled();
  });

  it("repairs loaded service definitions with port drift from gateway start", async () => {
    loadConfig.mockReturnValue({ gateway: { port: 19_001 } });
    resolveGatewayPort.mockReturnValue(19_001);
    repairLoadedGatewayServiceForStart.mockResolvedValue({
      result: "started",
      message: "Gateway service definition repaired and started.",
      loaded: true,
    });
    runServiceStart.mockImplementation(
      async (params: {
        repairLoadedService?: (args: {
          json: boolean;
          stdout: NodeJS.WritableStream;
          state: unknown;
          issues: unknown[];
        }) => Promise<unknown>;
      }) => {
        await params.repairLoadedService?.({
          json: true,
          stdout: process.stdout,
          state: { command: { environment: { OPENCLAW_GATEWAY_PORT: "18789" } } },
          issues: [{ code: "port-mismatch", message: "service port is stale" }],
        });
      },
    );

    await runDaemonStart({ json: true });

    expect(requireMockCallArg(runServiceStart, "runServiceStart").expectedPort).toBe(19_001);
    expect(repairLoadedGatewayServiceForStart).toHaveBeenCalledWith(
      expect.objectContaining({
        service,
        json: true,
        state: { command: { environment: { OPENCLAW_GATEWAY_PORT: "18789" } } },
        issues: [{ code: "port-mismatch", message: "service port is stale" }],
      }),
    );
  });

  it.each([
    { terminated: true, replaced: false, scheduled: false },
    { terminated: true, replaced: true, scheduled: false },
    { terminated: true, replaced: false, scheduled: true },
  ])(
    "retries stale cleanup only without a replacement owner (terminated=$terminated replaced=$replaced scheduled=$scheduled)",
    async ({ terminated, replaced, scheduled }) => {
      const unhealthy: RestartHealthSnapshot = {
        healthy: false,
        staleGatewayPids: [1993],
        runtime: { status: "stopped" },
        portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
      };
      waitForGatewayHealthyRestart.mockResolvedValueOnce(unhealthy);
      waitForGatewayHealthyRestart.mockResolvedValueOnce(createHealthyRestartSnapshot());
      terminateStaleGatewayPids.mockResolvedValue(terminated ? [1993] : []);
      service.restart.mockResolvedValue({ outcome: scheduled ? "scheduled" : "completed" });
      if (replaced) {
        readGatewayOwnerLease.mockReturnValue({
          owner: "replacement-owner",
          pid: 1994,
          host: "fixture-host",
          startedAt: 2000,
          port: 18789,
          mode: "supervised",
          supervisor: { kind: "schtasks", name: "OpenClaw Gateway" },
          state: "live",
          expired: false,
        });
      }

      await expect(runDaemonRestart({ json: true })).resolves.toBe(true);
      expect(service.restart).toHaveBeenCalledTimes(terminated && !replaced ? 1 : 0);
      expect(terminateStaleGatewayPids).toHaveBeenCalledWith(
        [1993],
        expect.objectContaining({ env: process.env, assertCurrent: expect.any(Function) }),
      );
      expect(waitForGatewayHealthyRestart).toHaveBeenCalledTimes(scheduled ? 1 : 2);
    },
  );

  it.each([
    {
      outcome: "timeout",
      elapsedMs: 360_000,
      runtime: "running",
      message: "Gateway restart timed out after 360s waiting for health checks.",
    },
    {
      outcome: "stopped-free",
      elapsedMs: 12_500,
      runtime: "stopped",
      message:
        "Gateway restart failed after 13s: service stayed stopped and health checks never came up.",
    },
  ])(
    "reports $outcome using the observed duration",
    async ({ outcome, elapsedMs, runtime, message }) => {
      const { formatCliCommand } = await import("../command-format.js");
      if (outcome === "timeout") {
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      }
      waitForGatewayHealthyRestart.mockResolvedValue({
        healthy: false,
        staleGatewayPids: [],
        runtime: { status: runtime },
        portUsage: { port: 18789, status: "free", listeners: [], hints: [] },
        waitOutcome: outcome,
        elapsedMs,
      });
      const error = await expectRestartError(runDaemonRestart({ json: true }));
      expect(error.message).toBe(message);
      expect(error.hints).toEqual([
        formatCliCommand("openclaw gateway status --deep"),
        formatCliCommand("openclaw doctor"),
      ]);
      if (outcome === "timeout") {
        expect(waitForGatewayHealthyRestart).toHaveBeenCalledWith(
          expect.objectContaining({
            attempts: 10_800,
            delayMs: 500,
            port: 18789,
          }),
        );
      }
      expect(terminateStaleGatewayPids).not.toHaveBeenCalled();
      expect(renderRestartDiagnostics).toHaveBeenCalledTimes(1);
    },
  );

  it("forces non-interactive stop of verified listeners instead of the stale lock owner", async () => {
    isTerminalInteractive.mockReturnValue(false);
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4300, 4300, 4400]);

    await runUnmanagedStop({ json: true, force: true });

    gatewayProcessChecks.listeners(18789, process.env);
    gatewayProcessChecks.signal(4300, "SIGTERM", 18789, process.env);
    gatewayProcessChecks.signal(4400, "SIGTERM", 18789, process.env);
    // Verified listeners win over the lock owner (pid 4200) when lsof can see them.
    gatewayProcessChecks.noSignal(4200, "SIGTERM", 18789, process.env);
    expect(appendGatewayLifecycleAudit).toHaveBeenCalledWith({
      action: "stop",
      source: "cli",
      mode: "sigterm",
      pid: 4300,
    });
  });

  it("blocks non-interactive stop without force before managed service access", async () => {
    isTerminalInteractive.mockReturnValue(false);
    const { defaultRuntime, ExitError } = await import("../../runtime.js");
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});

    const stopping = runDaemonStop({ json: true });
    await expect(stopping).rejects.toBeInstanceOf(ExitError);
    await expect(stopping).rejects.toMatchObject({ code: 1 });

    expect(writeJson).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        action: "stop",
        ok: false,
        error: expect.stringContaining("openclaw gateway run --dev"),
      }),
    );
    expect(runServiceStop).not.toHaveBeenCalled();
    expect(service.stop).not.toHaveBeenCalled();
    expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
  });

  it("routes macOS disable stops through the service manager when not loaded", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

    await runDaemonStop({ json: true, disable: true });

    expect(runServiceStop).toHaveBeenCalledWith(
      expect.objectContaining({
        opts: { json: true, disable: true },
        stopWhenNotLoaded: true,
      }),
    );
    expect(service.readCommand).not.toHaveBeenCalled();
    expect(loadConfig).not.toHaveBeenCalled();
    expect(resolveGatewayPort).not.toHaveBeenCalled();
  });

  it("stops a running disabled systemd unit through the service manager", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    service.readRuntime.mockResolvedValue({ status: "running" });

    await runUnmanagedStop();

    expect(service.stop).toHaveBeenCalledWith(
      expect.objectContaining({ env: process.env, stdout: process.stdout }),
    );
    expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
  });

  it("stops the active lock port when the configured port has drifted", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
    readActiveGatewayLockIdentity.mockResolvedValue({
      pid: 4300,
      createdAt: "2026-07-16T12:00:00.000Z",
      port: 39_471,
    });

    const outcome = await runUnmanagedStop();

    expect(service.readCommand).not.toHaveBeenCalled();
    expect(appendGatewayLifecycleAudit).toHaveBeenCalledWith({
      action: "stop",
      source: "cli",
      mode: "sigterm",
      pid: 4300,
    });
    expect(outcome).toEqual({
      result: "stopped",
      message: "Gateway stop signal sent to unmanaged process on port 39471: 4300.",
    });
    gatewayProcessChecks.listeners(39_471, process.env);
    gatewayProcessChecks.signal(4300, "SIGTERM", 39_471, process.env);
  });

  it("preserves SIGUSR1 restart delivery for a verified pre-upgrade gateway lock", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-non-default-service-state";
    readActiveGatewayLockIdentity.mockResolvedValue(
      createGatewayLockIdentity({ ownerId: undefined }),
    );
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200]);
    mockUnmanagedRestart({ runPostRestartCheck: true });

    await runDaemonRestart({ json: true, wait: "30s" });

    gatewayProcessChecks.listeners(18789);
    expect(findInstalledSystemdGatewayScope).not.toHaveBeenCalled();
    gatewayProcessChecks.signal(4200, "SIGUSR1", 18789);
    expect(callGatewayCli).not.toHaveBeenCalled();
    expect(writeGatewayRestartIntentSync).toHaveBeenCalledWith({
      targetPid: 4200,
      reason: "gateway.restart",
      intent: { waitMs: 30_000 },
    });
    expect(appendGatewayLifecycleAudit).toHaveBeenCalledWith({
      action: "restart",
      source: "cli",
      mode: "sigusr1",
      pid: 4200,
    });
    expect(probeGateway).toHaveBeenCalledTimes(1);
    expect(waitForGatewayHealthyListener).toHaveBeenCalledTimes(1);
    expect(waitForGatewayHealthyRestart).not.toHaveBeenCalled();
    expect(terminateStaleGatewayPids).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
  });

  it("rejects denied Darwin recovery when no unmanaged listener exists", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-non-default-service-state";
    mockUnmanagedRestart();

    await expect(runDaemonRestart({ json: true })).rejects.toThrow(/non-default state dir/);

    expect(recoverInstalledLaunchAgent).not.toHaveBeenCalled();
    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["another process", { pid: 4300, createdAt: "2026-07-16T12:00:00.000Z", port: 18_789 }],
    ["another port", { pid: 4200, createdAt: "2026-07-16T12:00:00.000Z", port: 19_001 }],
  ] as const)("refuses unmanaged restart when the lock identifies %s", async (_label, lock) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    readActiveGatewayLockIdentity.mockResolvedValue(lock);
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200]);
    mockUnmanagedRestart();

    await expect(runDaemonRestart({ json: true })).rejects.toThrow(
      'gateway lock identity does not match the verified listener on port 18789; use "openclaw gateway status --deep"',
    );

    expect(writeGatewayRestartIntentSync).not.toHaveBeenCalled();
    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
    expect(callGatewayCli).not.toHaveBeenCalled();
  });

  it("uses the legacy local RPC contract for a pre-upgrade Windows gateway lock", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    readActiveGatewayLockIdentity.mockResolvedValue(
      createGatewayLockIdentity({ ownerId: undefined }),
    );
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200]);
    mockUnmanagedRestart({ runPostRestartCheck: true });

    await runDaemonRestart({ json: true, wait: "30s" });

    expectRestartRpc(
      {
        reason: "gateway.restart",
        skipDeferral: true,
      },
      18_789,
    );
    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
    expect(writeGatewayRestartIntentSync).toHaveBeenCalledWith({
      targetPid: 4200,
      reason: "gateway.restart",
      intent: { waitMs: 30_000 },
    });
    expect(clearGatewayRestartIntentSync).not.toHaveBeenCalled();
    expectListenerHealth(10_860, createGatewayLockIdentity({ ownerId: undefined }), process.env);
  });

  it("restarts and verifies the active unmanaged port despite a config edit", async () => {
    loadConfig.mockReturnValue({ gateway: { port: 19_001 } });
    callGatewayCli.mockResolvedValueOnce({ ok: true, status: "emitted", pid: 4200 });
    readActiveGatewayLockPort.mockResolvedValue(18_789);
    findVerifiedGatewayListenerPidsOnPortSync.mockImplementation((port) =>
      port === 18_789 ? [4200] : [],
    );
    mockUnmanagedRestart({ runPostRestartCheck: true });

    await runDaemonRestart({ json: true });

    expect(requireMockCallArg(runServiceRestart, "runServiceRestart").expectedPort).toBe(19_001);
    gatewayProcessChecks.listeners(18_789);
    expect(probeGateway).toHaveBeenCalledWith(
      expect.objectContaining({ url: "ws://127.0.0.1:18789" }),
    );
    expect(callGatewayCli).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "gateway.restart.request",
        localPortOverride: 18_789,
        params: expect.objectContaining({
          target: { pid: 4200, ownerId: "gateway-owner-old", port: 18_789 },
        }),
      }),
    );
    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
    expect(waitForGatewayHealthyListener).toHaveBeenCalledWith(
      expect.objectContaining({ port: 18_789 }),
    );
  });

  it("prefers launchd repair over unmanaged restart when an installed LaunchAgent is unloaded", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    recoverInstalledLaunchAgent.mockResolvedValue({
      result: "restarted",
      loaded: true,
      message: "Gateway LaunchAgent was installed but not loaded; re-bootstrapped launchd service.",
    });
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200]);
    mockUnmanagedRestart({ runPostRestartCheck: true });

    await runDaemonRestart({ json: true });

    expect(recoverInstalledLaunchAgent).toHaveBeenCalledWith({ result: "restarted" });
    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
    expect(waitForGatewayHealthyListener).not.toHaveBeenCalled();
    expect(waitForGatewayHealthyRestart).toHaveBeenCalledWith(
      expect.objectContaining({ supervisorKeepsAlive: true }),
    );
  });

  it("fails unmanaged restart when multiple gateway listeners are present", async () => {
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-non-default-service-state";
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200, 4300]);
    mockUnmanagedRestart();

    await expect(runDaemonRestart({ json: true })).rejects.toThrow(
      "multiple gateway processes are listening on port 18789",
    );
  });

  it("fails unmanaged restart when the running gateway has commands.restart disabled", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200]);
    probeGateway.mockResolvedValue({
      ok: true,
      configSnapshot: { commands: { restart: false } },
    });
    mockUnmanagedRestart();

    await expect(runDaemonRestart({ json: true })).rejects.toThrow(
      "Gateway restart is disabled in the running gateway config",
    );
  });

  function mockSystemdScope(unit: string) {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    findInstalledSystemdGatewayScope.mockResolvedValue({
      scope: "system" as const,
      unitName: unit,
      unitPath: `/etc/systemd/system/${unit}`,
    });
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200]);
  }

  it("delegates system-scope restart to systemctl without unmanaged signaling when root (openclaw#87577)", async () => {
    mockSystemdScope("openclaw.service");
    restartSystemdService.mockResolvedValue({ outcome: "completed" });
    mockUnmanagedRestart();

    await expect(runDaemonRestart({ json: true })).resolves.toBe(true);

    expect(restartSystemdService).toHaveBeenCalled();
    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
    expect(probeGateway).not.toHaveBeenCalled();
  });

  it("surfaces systemd sudo guidance and never signals when restarting a system-scope unit as non-root (openclaw#87577)", async () => {
    mockSystemdScope("openclaw.service");
    restartSystemdService.mockRejectedValue(
      new Error(
        "openclaw.service is a system-scope unit (/etc/systemd/system/openclaw.service); run `sudo systemctl restart openclaw.service` to restart it",
      ),
    );
    mockUnmanagedRestart();

    await expect(runDaemonRestart({ json: true })).rejects.toThrow(
      /sudo systemctl restart openclaw\.service/,
    );

    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
    expect(probeGateway).not.toHaveBeenCalled();
  });

  it("delegates system-scope stop to systemctl without unmanaged signaling when root (openclaw#87577)", async () => {
    mockSystemdScope("openclaw-gateway.service");
    stopSystemdService.mockResolvedValue(undefined);
    await expect(runUnmanagedStop()).resolves.toEqual(
      expect.objectContaining({ result: "stopped" }),
    );
    expect(stopSystemdService).toHaveBeenCalled();
    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
  });

  it.each([
    ["free", undefined],
    ["unknown", "Could not determine whether port 18789 is still in use"],
  ] as const)(
    "handles an unowned gateway port reported as %s",
    async (portUsage, expectedError) => {
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
      readActiveGatewayLockIdentity.mockResolvedValue(undefined);
      probePortUsage.mockResolvedValue(portUsage);

      const outcome = runUnmanagedStop();
      if (expectedError) {
        await expect(outcome).rejects.toThrow(expectedError);
      } else {
        await expect(outcome).resolves.toBeNull();
      }
    },
  );

  it("resolves port and probe hosts from selected service config/env (no --port arg)", async () => {
    const serviceCommand = {
      programArguments: ["openclaw", "gateway"],
      environment: { OPENCLAW_STATE_DIR: "/tmp/service-state" },
    };
    service.readCommand.mockResolvedValue(serviceCommand);
    loadConfig.mockReturnValue({ gateway: { port: 18789 } });
    createConfigIO.mockImplementation((opts) => ({
      readBestEffortConfig: async () => ({
        gateway: { port: opts?.env?.OPENCLAW_STATE_DIR === "/tmp/service-state" ? 19000 : 18789 },
      }),
    }));
    resolveGatewayPort.mockImplementation((cfg) => {
      return (cfg as { gateway?: { port?: number } } | undefined)?.gateway?.port ?? 18789;
    });
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
    readActiveGatewayLockIdentity.mockResolvedValue(undefined);
    probePortUsage.mockResolvedValue("busy");

    await expect(runUnmanagedStop()).rejects.toThrow(/Port 19000/);
    expect(resolveGatewayServiceProbeHosts).toHaveBeenCalledWith(
      expect.objectContaining({ command: serviceCommand }),
    );
    expect(probePortUsage).toHaveBeenCalledWith(19000, ["127.0.0.1"]);
  });
  describe("external supervision", () => {
    beforeEach(() => {
      process.env.OPENCLAW_SUPERVISOR_MODE = "external";
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200]);
      callGatewayCli.mockResolvedValue({ ok: true, status: "emitted", pid: 4200 });
    });
    async function expectExternalRestartFailure(message: string) {
      const { defaultRuntime } = await import("../../runtime.js");
      const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});

      await expectRestartError(runDaemonRestart({ json: true }));

      expect(writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "restart",
          ok: false,
          error: expect.stringContaining(message),
        }),
      );
    }

    it("restarts through the exact running Gateway without candidate state access", async () => {
      const lockIdentity = { ...createGatewayLockIdentity(), port: 19_455 };
      readActiveGatewayLockPort.mockResolvedValue(19_455);
      readActiveGatewayLockIdentity.mockResolvedValue(lockIdentity);

      const { defaultRuntime } = await import("../../runtime.js");
      const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
      await expect(runDaemonRestart({ force: true })).resolves.toBe(true);
      expect(log).toHaveBeenCalledExactlyOnceWith(
        "Gateway restart request sent to externally supervised process on port 19455: 4200.",
      );
      expect(waitForGatewayHealthyListener.mock.invocationCallOrder[0]).toBeLessThan(
        log.mock.invocationCallOrder[0]!,
      );

      expect(runServiceRestart).not.toHaveBeenCalled();
      expect(service.readCommand).not.toHaveBeenCalled();
      expect(findInstalledSystemdGatewayScope).not.toHaveBeenCalled();
      expect(probeGateway).not.toHaveBeenCalled();
      expect(loadConfig).not.toHaveBeenCalled();
      expectRestartRpc(
        {
          reason: "gateway.restart",
          target: {
            pid: 4200,
            ownerId: "gateway-owner-old",
            port: 19_455,
          },
          restartIntent: { force: true, drainBudgetMs: 300_000 },
        },
        19_455,
      );
      expect(writeGatewayRestartIntentSync).not.toHaveBeenCalled();
      expect(clearGatewayRestartIntentSync).not.toHaveBeenCalled();
      expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
      expect(appendGatewayLifecycleAudit).toHaveBeenCalledWith({
        action: "restart",
        source: "supervisor",
        mode: "rpc",
        pid: 4200,
      });
      expectListenerHealth(720, lockIdentity);
    });

    it("keeps safe restarts on the exact local lock owner", async () => {
      callGatewayCli.mockResolvedValue({
        ok: true,
        status: "scheduled",
        preflight: { safe: false, summary: "restart deferred", blockers: [] },
        restart: { pid: 4200 },
      });

      await runDaemonRestart({ json: true, safe: true, skipDeferral: true });

      expectRestartRpc(
        {
          reason: "gateway.restart.safe",
          safe: true,
          skipDeferral: true,
          target: restartTarget,
        },
        18_789,
        true,
      );
      expect(loadConfig).not.toHaveBeenCalled();
      expect(writeGatewayRestartIntentSync).not.toHaveBeenCalled();
      expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
    });

    it("does not touch state when lock ownership changes before delivery", async () => {
      const gatewayLockIdentity = createGatewayLockIdentity();
      readActiveGatewayLockIdentity
        .mockResolvedValueOnce(gatewayLockIdentity)
        .mockResolvedValueOnce(gatewayLockIdentity)
        .mockResolvedValue({
          ...gatewayLockIdentity,
          pid: 4300,
          ownerId: "gateway-owner-new",
          createdAt: "2026-07-16T12:00:01.000Z",
        });

      await expectExternalRestartFailure("gateway lock owner changed");

      expect(writeGatewayRestartIntentSync).not.toHaveBeenCalled();
      expect(clearGatewayRestartIntentSync).not.toHaveBeenCalled();
      expect(callGatewayCli).not.toHaveBeenCalled();
      expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
    });

    it("rejects a legacy generic restart acknowledgement", async () => {
      callGatewayCli.mockResolvedValue({
        ok: true,
        status: "deferred",
        restart: { pid: 4200 },
      });

      await expectExternalRestartFailure("invalid restart acknowledgement");

      expect(writeGatewayRestartIntentSync).not.toHaveBeenCalled();
      expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
      expect(waitForGatewayHealthyListener).not.toHaveBeenCalled();
    });

    it("fails closed before delivery for a pre-targeted-restart Gateway lock", async () => {
      readActiveGatewayLockIdentity.mockResolvedValue({
        pid: 4200,
        createdAt: "2026-07-16T12:00:00.000Z",
        port: 18_789,
      });

      await expectExternalRestartFailure("predates targeted restart ownership");

      expect(callGatewayCli).not.toHaveBeenCalled();
      expect(writeGatewayRestartIntentSync).not.toHaveBeenCalled();
      expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
    });

    it.each([
      ["start", () => runDaemonStart({ json: true })],
      ["stop", () => runDaemonStop({ json: true })],
      ["uninstall", () => runDaemonUninstall({ json: true })],
      ["preserved restart", () => runDaemonRestart({ json: true, preserveDefinition: true })],
    ])("blocks native %s lifecycle access", async (_action, run) => {
      await expect(run()).rejects.toThrow("gateway lifecycle is managed by an external supervisor");

      expect(runServiceStart).not.toHaveBeenCalled();
      expect(runServiceRestart).not.toHaveBeenCalled();
      expect(runServiceStop).not.toHaveBeenCalled();
      expect(runServiceUninstall).not.toHaveBeenCalled();
      expect(service.readCommand).not.toHaveBeenCalled();
      expect(readActiveGatewayLockIdentity).not.toHaveBeenCalled();
      expect(callGatewayCli).not.toHaveBeenCalled();
      expect(writeGatewayRestartIntentSync).not.toHaveBeenCalled();
      expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
    });
  });
});
