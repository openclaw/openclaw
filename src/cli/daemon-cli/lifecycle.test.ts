import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRestartReadinessGate } from "../../gateway/restart-recovery.js";
import { captureEnv } from "../../test-utils/env.js";

type RestartHealthSnapshot = {
  healthy: boolean;
  staleGatewayPids: number[];
  runtime: { status?: string };
  portUsage: { port: number; status: string; listeners: []; hints: []; errors?: string[] };
};

type RestartPostCheckContext = {
  json: boolean;
  stdout: NodeJS.WritableStream;
  warnings: string[];
  fail: (message: string, hints?: string[]) => void;
};

type RestartParams = {
  opts?: { json?: boolean };
  postRestartCheck?: (ctx: RestartPostCheckContext) => Promise<void>;
};

const service = {
  readCommand: vi.fn(),
  restart: vi.fn(),
};

const runServiceRestart = vi.fn();
const runServiceStop = vi.fn();
const waitForGatewayHealthyListener = vi.fn();
const waitForGatewayHealthyRestart = vi.fn();
const terminateStaleGatewayPids = vi.fn();
const renderGatewayPortHealthDiagnostics = vi.fn(() => ["diag: unhealthy port"]);
const renderRestartDiagnostics = vi.fn(() => ["diag: unhealthy runtime"]);
const resolveGatewayPort = vi.fn(() => 18789);
const findVerifiedGatewayListenerPidsOnPortSync = vi.fn<(port: number) => number[]>(() => []);
const signalVerifiedGatewayPidSync = vi.fn<(pid: number, signal: "SIGTERM" | "SIGUSR1") => void>();
const formatGatewayPidList = vi.fn<(pids: number[]) => string>((pids) => pids.join(", "));
const probeGateway = vi.fn<
  (opts: {
    url: string;
    auth?: { token?: string; password?: string };
    timeoutMs: number;
  }) => Promise<{
    ok: boolean;
    configSnapshot: unknown;
  }>
>();
const isRestartEnabled = vi.fn<(config?: { commands?: unknown }) => boolean>(() => true);
const loadConfig = vi.fn(() => ({}));
const evaluateGatewayRestartReadinessGate = vi.fn<() => GatewayRestartReadinessGate>(() => ({
  blocked: false,
  threshold: 0,
  summary: "",
  activeSessions: [],
  activeCronRuns: [],
  totalActive: 0,
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => loadConfig(),
  readBestEffortConfig: async () => loadConfig(),
  resolveGatewayPort,
}));

vi.mock("../../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync: (port: number) =>
    findVerifiedGatewayListenerPidsOnPortSync(port),
  signalVerifiedGatewayPidSync: (pid: number, signal: "SIGTERM" | "SIGUSR1") =>
    signalVerifiedGatewayPidSync(pid, signal),
  formatGatewayPidList: (pids: number[]) => formatGatewayPidList(pids),
}));

vi.mock("../../gateway/probe.js", () => ({
  probeGateway: (opts: {
    url: string;
    auth?: { token?: string; password?: string };
    timeoutMs: number;
  }) => probeGateway(opts),
}));

vi.mock("../../config/commands.js", () => ({
  isRestartEnabled: (config?: { commands?: unknown }) => isRestartEnabled(config),
}));

vi.mock("../../gateway/restart-recovery.js", () => ({
  evaluateGatewayRestartReadinessGate: () => evaluateGatewayRestartReadinessGate(),
}));

vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => service,
}));

vi.mock("./restart-health.js", () => ({
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
  runServiceStart: vi.fn(),
  runServiceStop,
  runServiceUninstall: vi.fn(),
}));

describe("runDaemonRestart health checks", () => {
  let runDaemonRestart: (opts?: { json?: boolean; force?: boolean }) => Promise<boolean>;
  let runDaemonStop: (opts?: { json?: boolean }) => Promise<void>;
  let envSnapshot: ReturnType<typeof captureEnv>;

  function mockUnmanagedRestart({
    runPostRestartCheck = false,
  }: {
    runPostRestartCheck?: boolean;
  } = {}) {
    runServiceRestart.mockImplementation(
      async (params: RestartParams & { onNotLoaded?: () => Promise<unknown> }) => {
        await params.onNotLoaded?.();
        if (runPostRestartCheck) {
          await params.postRestartCheck?.({
            json: Boolean(params.opts?.json),
            stdout: process.stdout,
            warnings: [],
            fail: (message: string) => {
              throw new Error(message);
            },
          });
        }
        return true;
      },
    );
  }

  beforeAll(async () => {
    ({ runDaemonRestart, runDaemonStop } = await import("./lifecycle.js"));
  });

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_CONTAINER_HINT", "OPENCLAW_PROFILE"]);
    delete process.env.OPENCLAW_CONTAINER_HINT;
    service.readCommand.mockReset();
    service.restart.mockReset();
    runServiceRestart.mockReset();
    runServiceStop.mockReset();
    waitForGatewayHealthyListener.mockReset();
    waitForGatewayHealthyRestart.mockReset();
    terminateStaleGatewayPids.mockReset();
    renderGatewayPortHealthDiagnostics.mockReset();
    renderRestartDiagnostics.mockReset();
    evaluateGatewayRestartReadinessGate.mockReset().mockReturnValue({
      blocked: false,
      threshold: 0,
      summary: "",
      activeSessions: [],
      activeCronRuns: [],
      totalActive: 0,
    });
    resolveGatewayPort.mockReset();
    findVerifiedGatewayListenerPidsOnPortSync.mockReset();
    signalVerifiedGatewayPidSync.mockReset();
    formatGatewayPidList.mockReset();
    probeGateway.mockReset();
    isRestartEnabled.mockReset();
    loadConfig.mockReset();

    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "--port", "18789"],
      environment: {},
    });
    service.restart.mockResolvedValue({ outcome: "completed" });

    runServiceRestart.mockImplementation(async (params: RestartParams) => {
      const fail = (message: string, hints?: string[]) => {
        const err = new Error(message) as Error & { hints?: string[] };
        err.hints = hints;
        throw err;
      };
      await params.postRestartCheck?.({
        json: Boolean(params.opts?.json),
        stdout: process.stdout,
        warnings: [],
        fail,
      });
      return true;
    });
    runServiceStop.mockResolvedValue(undefined);
    waitForGatewayHealthyListener.mockResolvedValue({
      healthy: true,
      portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
    });
    probeGateway.mockResolvedValue({
      ok: true,
      configSnapshot: { commands: { restart: true } },
    });
    isRestartEnabled.mockReturnValue(true);
    signalVerifiedGatewayPidSync.mockImplementation(() => {});
    formatGatewayPidList.mockImplementation((pids) => pids.join(", "));
  });

  afterEach(() => {
    envSnapshot.restore();
    vi.restoreAllMocks();
  });

  it("kills stale gateway pids and retries restart", async () => {
    const unhealthy: RestartHealthSnapshot = {
      healthy: false,
      staleGatewayPids: [1993],
      runtime: { status: "stopped" },
      portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
    };
    const healthy: RestartHealthSnapshot = {
      healthy: true,
      staleGatewayPids: [],
      runtime: { status: "running" },
      portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
    };
    waitForGatewayHealthyRestart.mockResolvedValueOnce(unhealthy).mockResolvedValueOnce(healthy);
    terminateStaleGatewayPids.mockResolvedValue([1993]);

    const result = await runDaemonRestart({ json: true });

    expect(result).toBe(true);
    expect(terminateStaleGatewayPids).toHaveBeenCalledWith([1993]);
    expect(service.restart).toHaveBeenCalledTimes(1);
    expect(waitForGatewayHealthyRestart).toHaveBeenCalledTimes(2);
  });

  it("skips stale-pid retry health checks when the retry restart is only scheduled", async () => {
    const unhealthy: RestartHealthSnapshot = {
      healthy: false,
      staleGatewayPids: [1993],
      runtime: { status: "stopped" },
      portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
    };
    waitForGatewayHealthyRestart.mockResolvedValueOnce(unhealthy);
    terminateStaleGatewayPids.mockResolvedValue([1993]);
    service.restart.mockResolvedValueOnce({ outcome: "scheduled" });

    const result = await runDaemonRestart({ json: true });

    expect(result).toBe(true);
    expect(terminateStaleGatewayPids).toHaveBeenCalledWith([1993]);
    expect(service.restart).toHaveBeenCalledTimes(1);
    expect(waitForGatewayHealthyRestart).toHaveBeenCalledTimes(1);
  });

  it("fails restart when gateway remains unhealthy", async () => {
    const { formatCliCommand } = await import("../command-format.js");
    const unhealthy: RestartHealthSnapshot = {
      healthy: false,
      staleGatewayPids: [],
      runtime: { status: "stopped" },
      portUsage: { port: 18789, status: "free", listeners: [], hints: [] },
    };
    waitForGatewayHealthyRestart.mockResolvedValue(unhealthy);

    await expect(runDaemonRestart({ json: true })).rejects.toMatchObject({
      message: "Gateway restart timed out after 60s waiting for health checks.",
      hints: [
        formatCliCommand("openclaw gateway status --deep"),
        formatCliCommand("openclaw doctor"),
      ],
    });
    expect(terminateStaleGatewayPids).not.toHaveBeenCalled();
    expect(renderRestartDiagnostics).toHaveBeenCalledTimes(1);
  });

  it("signals an unmanaged gateway process on stop", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200, 4200, 4300]);
    runServiceStop.mockImplementation(async (params: { onNotLoaded?: () => Promise<unknown> }) => {
      await params.onNotLoaded?.();
    });

    await runDaemonStop({ json: true });

    expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(18789);
    expect(signalVerifiedGatewayPidSync).toHaveBeenCalledWith(4200, "SIGTERM");
    expect(signalVerifiedGatewayPidSync).toHaveBeenCalledWith(4300, "SIGTERM");
  });

  it("signals a single unmanaged gateway process on restart", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200]);
    mockUnmanagedRestart({ runPostRestartCheck: true });

    await runDaemonRestart({ json: true });

    expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(18789);
    expect(signalVerifiedGatewayPidSync).toHaveBeenCalledWith(4200, "SIGUSR1");
    expect(probeGateway).toHaveBeenCalledTimes(1);
    expect(waitForGatewayHealthyListener).toHaveBeenCalledTimes(1);
    expect(waitForGatewayHealthyRestart).not.toHaveBeenCalled();
    expect(terminateStaleGatewayPids).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
  });

  it("blocks restart without force when readiness gate reports active work", async () => {
    evaluateGatewayRestartReadinessGate.mockReturnValue({
      blocked: true,
      threshold: 0,
      summary:
        "1 active item(s) would be interrupted by gateway restart.\nRe-run with --force to proceed.",
      activeSessions: [{ key: "agent:main:main", status: "running", activeSubagents: [] }],
      activeCronRuns: [],
      totalActive: 1,
    });

    const result = await runDaemonRestart({ json: true });

    expect(result).toBe(false);
    expect(runServiceRestart).not.toHaveBeenCalled();
  });

  it("fails unmanaged restart when multiple gateway listeners are present", async () => {
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
    isRestartEnabled.mockReturnValue(false);
    mockUnmanagedRestart();

    await expect(runDaemonRestart({ json: true })).rejects.toThrow(
      "Gateway restart is disabled in the running gateway config",
    );
  });

  it("skips unmanaged signaling for pids that are not live gateway processes", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
    runServiceStop.mockImplementation(async (params: { onNotLoaded?: () => Promise<unknown> }) => {
      await params.onNotLoaded?.();
    });

    await runDaemonStop({ json: true });

    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
  });
});
