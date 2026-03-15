import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
  onBeforeRestartAction?: () => Promise<void> | void;
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
const createConfigIO = vi.fn(() => ({
  loadConfig: () => loadConfig(),
}));
const resolveMainSessionKey = vi.fn(() => "agent:main:main");
const extractDeliveryInfo = vi.fn(() => ({
  deliveryContext: { channel: "telegram", to: "7174833131" },
  threadId: undefined,
}));
const writeRestartSentinel = vi.fn();
const transitionRestartSentinelStatus = vi.fn();

vi.mock("../../config/sessions.js", () => ({
  resolveMainSessionKey,
  extractDeliveryInfo,
}));

vi.mock("../../infra/restart-sentinel.js", () => ({
  formatDoctorNonInteractiveHint: () => "doctor-hint",
  writeRestartSentinel,
  transitionRestartSentinelStatus,
}));
vi.mock("../../config/config.js", () => ({
  loadConfig: () => loadConfig(),
  readBestEffortConfig: async () => loadConfig(),
  resolveGatewayPort,
}));

vi.mock("../../config/io.js", () => ({
  createConfigIO: (...args: unknown[]) => createConfigIO(...args),
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
  let runDaemonRestart: (opts?: { json?: boolean }) => Promise<boolean>;
  let runDaemonStop: (opts?: { json?: boolean }) => Promise<void>;

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
    service.readCommand.mockReset();
    service.restart.mockReset();
    runServiceRestart.mockReset();
    runServiceStop.mockReset();
    waitForGatewayHealthyListener.mockReset();
    waitForGatewayHealthyRestart.mockReset();
    terminateStaleGatewayPids.mockReset();
    renderGatewayPortHealthDiagnostics.mockReset();
    renderRestartDiagnostics.mockReset();
    resolveGatewayPort.mockReset();
    findVerifiedGatewayListenerPidsOnPortSync.mockReset();
    signalVerifiedGatewayPidSync.mockReset();
    formatGatewayPidList.mockReset();
    probeGateway.mockReset();
    isRestartEnabled.mockReset();
    loadConfig.mockReset();
    writeRestartSentinel.mockReset();
    transitionRestartSentinelStatus.mockReset();
    createConfigIO.mockClear();
    resolveMainSessionKey.mockClear();
    extractDeliveryInfo.mockClear();

    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "--port", "18789"],
      environment: {},
    });
    service.restart.mockResolvedValue({ outcome: "completed" });
    resolveMainSessionKey.mockReturnValue("agent:main:main");
    extractDeliveryInfo.mockReturnValue({
      deliveryContext: { channel: "telegram", to: "7174833131" },
      threadId: undefined,
    });

    runServiceRestart.mockImplementation(async (params: RestartParams) => {
      const fail = (message: string, hints?: string[]) => {
        const err = new Error(message) as Error & { hints?: string[] };
        err.hints = hints;
        throw err;
      };
      await params.onBeforeRestartAction?.();
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

  it("keeps restart sentinel non-final until the restart succeeds", async () => {
    waitForGatewayHealthyRestart.mockResolvedValue({
      healthy: true,
      staleGatewayPids: [],
      runtime: { status: "running" },
      portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
    });

    const result = await runDaemonRestart({ json: true, notify: true, note: "hello" });

    expect(result).toBe(true);
    expect(writeRestartSentinel).toHaveBeenCalledTimes(1);
    expect(writeRestartSentinel).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "restart",
        status: "pending",
        message: "hello",
      }),
    );
    expect(transitionRestartSentinelStatus).toHaveBeenNthCalledWith(
      1,
      "in-progress",
      expect.objectContaining({
        allowedCurrentStatuses: ["pending"],
      }),
    );
    expect(transitionRestartSentinelStatus).toHaveBeenNthCalledWith(
      2,
      "ok",
      expect.objectContaining({
        allowedCurrentStatuses: ["in-progress"],
      }),
    );

    // Ensure the final ok transition happens after the service restart flow completes.
    const restartOrder = runServiceRestart.mock.invocationCallOrder[0];
    const finalizeOrder = transitionRestartSentinelStatus.mock.invocationCallOrder[1];
    expect(finalizeOrder).toBeGreaterThan(restartOrder);
  });

  it("resolves --notify session context from service environment", async () => {
    const daemonCfg = { session: { scope: "agent", mainKey: "daemon-main" } };
    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "--port", "18789"],
      environment: { OPENCLAW_STATE_DIR: "/tmp/daemon-state" },
    });
    createConfigIO.mockReturnValue({
      loadConfig: () => daemonCfg,
    });
    resolveMainSessionKey.mockReturnValue("agent:daemon:daemon-main");
    extractDeliveryInfo.mockReturnValue({
      deliveryContext: { channel: "telegram", to: "7174833131" },
      threadId: undefined,
    });
    waitForGatewayHealthyRestart.mockResolvedValue({
      healthy: true,
      staleGatewayPids: [],
      runtime: { status: "running" },
      portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
    });

    const { runDaemonRestart } = await import("./lifecycle.js");
    const result = await runDaemonRestart({ json: true, notify: true });

    expect(result).toBe(true);
    expect(createConfigIO).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ OPENCLAW_STATE_DIR: "/tmp/daemon-state" }),
      }),
    );
    expect(resolveMainSessionKey).toHaveBeenCalledWith(daemonCfg);
    expect(extractDeliveryInfo).toHaveBeenCalledWith("agent:daemon:daemon-main", {
      cfg: daemonCfg,
    });
  });

  it("does not finalize restart sentinel when restart action never begins", async () => {
    let sentinelStatus: "pending" | "in-progress" | "ok" = "pending";
    writeRestartSentinel.mockImplementation(async () => {
      sentinelStatus = "pending";
    });
    transitionRestartSentinelStatus.mockImplementation(
      async (
        next: "pending" | "in-progress" | "ok",
        options?: { allowedCurrentStatuses?: string[] },
      ) => {
        const allowed = options?.allowedCurrentStatuses ?? [];
        if (allowed.length > 0 && !allowed.includes(sentinelStatus)) {
          throw new Error(`invalid transition ${sentinelStatus} -> ${next}`);
        }
        sentinelStatus = next;
      },
    );
    runServiceRestart.mockImplementation(async () => true);

    const { runDaemonRestart } = await import("./lifecycle.js");
    const result = await runDaemonRestart({ json: true, notify: true });

    expect(result).toBe(true);
    expect(sentinelStatus).toBe("pending");
    expect(transitionRestartSentinelStatus).toHaveBeenCalledTimes(1);
    expect(transitionRestartSentinelStatus).toHaveBeenCalledWith(
      "ok",
      expect.objectContaining({
        allowedCurrentStatuses: ["in-progress"],
      }),
    );
  });

  it("fails restart when gateway remains unhealthy", async () => {
    const unhealthy: RestartHealthSnapshot = {
      healthy: false,
      staleGatewayPids: [],
      runtime: { status: "stopped" },
      portUsage: { port: 18789, status: "free", listeners: [], hints: [] },
    };
    waitForGatewayHealthyRestart.mockResolvedValue(unhealthy);

    await expect(runDaemonRestart({ json: true })).rejects.toMatchObject({
      message: "Gateway restart timed out after 60s waiting for health checks.",
      hints: ["openclaw gateway status --deep", "openclaw doctor"],
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
