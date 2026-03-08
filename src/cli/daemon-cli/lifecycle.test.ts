import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockReadFileSync = vi.hoisted(() => vi.fn());
const mockSpawnSync = vi.hoisted(() => vi.fn());

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
const findGatewayPidsOnPortSync = vi.fn<(port: number) => number[]>(() => []);
const loadConfig = vi.fn(() => ({}));

vi.mock("node:fs", () => ({
  default: {
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  },
}));

vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
}));

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
    findGatewayPidsOnPortSync.mockReset();
    loadConfig.mockReset();
    mockReadFileSync.mockReset();
    mockSpawnSync.mockReset();

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
    waitForGatewayHealthyListener.mockResolvedValue({
      healthy: true,
      portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
    });
    mockReadFileSync.mockImplementation((path: string) => {
      const match = path.match(/\/proc\/(\d+)\/cmdline$/);
      if (!match) {
        throw new Error(`unexpected path ${path}`);
      }
      const pid = Number.parseInt(match[1] ?? "", 10);
      if ([4200, 4300].includes(pid)) {
        return ["openclaw", "gateway", "--port", "18789", ""].join("\0");
      }
      throw new Error(`unknown pid ${pid}`);
    });
    mockSpawnSync.mockReturnValue({
      error: null,
      status: 0,
      stdout: "openclaw gateway --port 18789",
      stderr: "",
    });
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
        await params.postRestartCheck?.({
          json: Boolean(params.opts?.json),
          stdout: process.stdout,
          warnings: [],
          fail: (message: string) => {
            throw new Error(message);
          },
        });
        return true;
      },
    );

    await runDaemonRestart({ json: true });

    expect(findGatewayPidsOnPortSync).toHaveBeenCalledWith(18789);
    expect(killSpy).toHaveBeenCalledWith(4200, "SIGUSR1");
    expect(waitForGatewayHealthyListener).toHaveBeenCalledTimes(1);
    expect(waitForGatewayHealthyRestart).not.toHaveBeenCalled();
    expect(terminateStaleGatewayPids).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
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

  it("skips unmanaged signaling for pids that are not live gateway processes", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    findGatewayPidsOnPortSync.mockReturnValue([4200]);
    mockReadFileSync.mockReturnValue(["python", "-m", "http.server", ""].join("\0"));
    mockSpawnSync.mockReturnValue({
      error: null,
      status: 0,
      stdout: "python -m http.server",
      stderr: "",
    });
    runServiceStop.mockImplementation(async (params: { onNotLoaded?: () => Promise<unknown> }) => {
      await params.onNotLoaded?.();
    });

    await runDaemonStop({ json: true });

    expect(killSpy).not.toHaveBeenCalled();
  });
});
