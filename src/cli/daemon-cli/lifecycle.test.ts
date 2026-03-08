import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
const waitForGatewayHealthyRestart = vi.fn();
const terminateStaleGatewayPids = vi.fn();
const renderRestartDiagnostics = vi.fn(() => ["diag: unhealthy runtime"]);
const resolveGatewayPort = vi.fn(() => 18789);
const findGatewayPidsOnPortSync = vi.fn<(port: number) => number[]>(() => []);
const loadConfig = vi.fn(() => ({}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => loadConfig(),
  readBestEffortConfig: async () => loadConfig(),
  resolveGatewayPort,
}));

vi.mock("../../infra/restart.js", () => ({
  findGatewayPidsOnPortSync: (port: number) => findGatewayPidsOnPortSync(port),
}));

vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => service,
}));

vi.mock("./restart-health.js", () => ({
  DEFAULT_RESTART_HEALTH_ATTEMPTS: 120,
  DEFAULT_RESTART_HEALTH_DELAY_MS: 500,
  waitForGatewayHealthyRestart,
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

  beforeAll(async () => {
    ({ runDaemonRestart, runDaemonStop } = await import("./lifecycle.js"));
  });

  beforeEach(() => {
    service.readCommand.mockClear();
    service.restart.mockClear();
    runServiceRestart.mockClear();
    runServiceStop.mockClear();
    waitForGatewayHealthyRestart.mockClear();
    terminateStaleGatewayPids.mockClear();
    renderRestartDiagnostics.mockClear();
    resolveGatewayPort.mockClear();
    findGatewayPidsOnPortSync.mockClear();
    loadConfig.mockClear();

    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "--port", "18789"],
      environment: {},
    });

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
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    findGatewayPidsOnPortSync.mockReturnValue([4200, 4200, 4300]);
    runServiceStop.mockImplementation(async (params: { onNotLoaded?: () => Promise<unknown> }) => {
      await params.onNotLoaded?.();
    });

    await runDaemonStop({ json: true });

    expect(findGatewayPidsOnPortSync).toHaveBeenCalledWith(18789);
    expect(killSpy).toHaveBeenCalledWith(4200, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(4300, "SIGTERM");
  });

  it("signals a single unmanaged gateway process on restart", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    findGatewayPidsOnPortSync.mockReturnValue([4200]);
    runServiceRestart.mockImplementation(
      async (params: RestartParams & { onNotLoaded?: () => Promise<unknown> }) => {
        await params.onNotLoaded?.();
        return true;
      },
    );

    await runDaemonRestart({ json: true });

    expect(findGatewayPidsOnPortSync).toHaveBeenCalledWith(18789);
    expect(killSpy).toHaveBeenCalledWith(4200, "SIGUSR1");
  });

  it("fails unmanaged restart when multiple gateway listeners are present", async () => {
    findGatewayPidsOnPortSync.mockReturnValue([4200, 4300]);
    runServiceRestart.mockImplementation(
      async (params: RestartParams & { onNotLoaded?: () => Promise<unknown> }) => {
        await params.onNotLoaded?.();
        return true;
      },
    );

    await expect(runDaemonRestart({ json: true })).rejects.toThrow(
      "multiple gateway processes are listening on port 18789",
    );
  });
});
