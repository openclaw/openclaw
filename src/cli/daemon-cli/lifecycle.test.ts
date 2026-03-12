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
  onNotLoaded?: () => Promise<unknown>;
};

type StartParams = {
  opts?: { json?: boolean };
  onNotLoaded?: () => Promise<boolean>;
};

const service = {
  isLoaded: vi.fn(),
  readCommand: vi.fn(),
  restart: vi.fn(),
};

const runServiceStart = vi.fn();
const runServiceRestart = vi.fn();
const runServiceStop = vi.fn();
const waitForGatewayHealthyListener = vi.fn();
const waitForGatewayHealthyRestart = vi.fn();
const terminateStaleGatewayPids = vi.fn();
const renderGatewayPortHealthDiagnostics = vi.fn(() => ["diag: unhealthy port"]);
const renderRestartDiagnostics = vi.fn(() => ["diag: unhealthy runtime"]);
const resolveGatewayPort = vi.fn(() => 18789);
const findGatewayPidsOnPortSync = vi.fn<(port: number) => number[]>(() => []);
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
const launchAgentPlistExists = vi.fn<(env?: NodeJS.ProcessEnv) => Promise<boolean>>();
const repairLaunchAgentBootstrap =
  vi.fn<(args?: { env?: NodeJS.ProcessEnv }) => Promise<{ ok: boolean; detail?: string }>>();

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

vi.mock("../../daemon/launchd.js", () => ({
  launchAgentPlistExists: (env?: NodeJS.ProcessEnv) => launchAgentPlistExists(env),
  repairLaunchAgentBootstrap: (args?: { env?: NodeJS.ProcessEnv }) =>
    repairLaunchAgentBootstrap(args),
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
  runServiceStart,
  runServiceStop,
  runServiceUninstall: vi.fn(),
}));

describe("runDaemonRestart health checks", () => {
  let runDaemonStart: (opts?: { json?: boolean }) => Promise<void>;
  let runDaemonRestart: (opts?: { json?: boolean }) => Promise<boolean>;
  let runDaemonStop: (opts?: { json?: boolean }) => Promise<void>;

  beforeAll(async () => {
    ({ runDaemonStart, runDaemonRestart, runDaemonStop } = await import("./lifecycle.js"));
  });

  beforeEach(() => {
    service.isLoaded.mockReset();
    service.readCommand.mockReset();
    service.restart.mockReset();
    runServiceStart.mockReset();
    runServiceRestart.mockReset();
    runServiceStop.mockReset();
    waitForGatewayHealthyListener.mockReset();
    waitForGatewayHealthyRestart.mockReset();
    terminateStaleGatewayPids.mockReset();
    renderGatewayPortHealthDiagnostics.mockReset();
    renderRestartDiagnostics.mockReset();
    resolveGatewayPort.mockReset();
    findGatewayPidsOnPortSync.mockReset();
    probeGateway.mockReset();
    isRestartEnabled.mockReset();
    loadConfig.mockReset();
    launchAgentPlistExists.mockReset();
    repairLaunchAgentBootstrap.mockReset();
    mockReadFileSync.mockReset();
    mockSpawnSync.mockReset();

    service.isLoaded.mockResolvedValue(true);
    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "--port", "18789"],
      environment: {},
    });
    service.restart.mockResolvedValue({ outcome: "completed" });
    launchAgentPlistExists.mockResolvedValue(true);
    repairLaunchAgentBootstrap.mockResolvedValue({ ok: true });

    runServiceStart.mockResolvedValue(undefined);
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
    waitForGatewayHealthyRestart.mockResolvedValue({
      healthy: true,
      staleGatewayPids: [],
      runtime: { status: "running" },
      portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
    });
    probeGateway.mockResolvedValue({
      ok: true,
      configSnapshot: { commands: { restart: true } },
    });
    isRestartEnabled.mockReturnValue(true);
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

  it("provides a start recovery hook that re-registers a darwin LaunchAgent without kickstart", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

    await runDaemonStart({ json: true });

    const params = runServiceStart.mock.calls[0]?.[0] as StartParams | undefined;
    expect(params?.onNotLoaded).toBeTypeOf("function");
    const recovered = await params?.onNotLoaded?.();

    expect(recovered).toBe(true);
    expect(launchAgentPlistExists).toHaveBeenCalledWith(process.env);
    expect(repairLaunchAgentBootstrap).toHaveBeenCalledWith({
      env: process.env,
      kickstart: false,
    });
    expect(runServiceStart).toHaveBeenCalledTimes(1);
  });

  it("start recovery hook returns false when the plist is missing", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    launchAgentPlistExists.mockResolvedValueOnce(false);

    await runDaemonStart({ json: true });

    const params = runServiceStart.mock.calls[0]?.[0] as StartParams | undefined;
    const recovered = await params?.onNotLoaded?.();

    expect(recovered).toBe(false);
    expect(launchAgentPlistExists).toHaveBeenCalledWith(process.env);
    expect(repairLaunchAgentBootstrap).not.toHaveBeenCalled();
    expect(runServiceStart).toHaveBeenCalledTimes(1);
  });

  it("start recovery hook returns false outside macOS", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    await runDaemonStart({ json: true });

    const params = runServiceStart.mock.calls[0]?.[0] as StartParams | undefined;
    expect(params?.onNotLoaded).toBeUndefined();
    expect(launchAgentPlistExists).not.toHaveBeenCalled();
    expect(repairLaunchAgentBootstrap).not.toHaveBeenCalled();
    expect(runServiceStart).toHaveBeenCalledTimes(1);
  });

  it("start recovery hook falls back when launchd repair fails", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    repairLaunchAgentBootstrap.mockRejectedValueOnce(new Error("bootstrap failed"));

    await runDaemonStart({ json: true });

    const params = runServiceStart.mock.calls[0]?.[0] as StartParams | undefined;
    const recovered = await params?.onNotLoaded?.();

    expect(recovered).toBe(false);
    expect(repairLaunchAgentBootstrap).toHaveBeenCalledWith({
      env: process.env,
      kickstart: false,
    });
    expect(runServiceStart).toHaveBeenCalledTimes(1);
  });

  it("provides a restart recovery hook that kickstarts a darwin LaunchAgent", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

    await runDaemonRestart({ json: true });

    const params = runServiceRestart.mock.calls[0]?.[0] as RestartParams | undefined;
    const recovered = await params?.onNotLoaded?.();

    expect(recovered).toEqual({ result: "restarted", loaded: true });
    expect(launchAgentPlistExists).toHaveBeenCalledWith(process.env);
    expect(repairLaunchAgentBootstrap).toHaveBeenCalledWith({ env: process.env });
    expect(runServiceRestart).toHaveBeenCalledTimes(1);
  });

  it("restart recovery hook falls back to unmanaged restart when the plist is missing", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    launchAgentPlistExists.mockResolvedValueOnce(false);
    findGatewayPidsOnPortSync.mockReturnValue([4200]);

    await runDaemonRestart({ json: true });

    const params = runServiceRestart.mock.calls[0]?.[0] as RestartParams | undefined;
    const recovered = await params?.onNotLoaded?.();

    expect(recovered).toEqual({
      result: "restarted",
      message: "Gateway restart signal sent to unmanaged process on port 18789: 4200.",
    });
    expect(launchAgentPlistExists).toHaveBeenCalledWith(process.env);
    expect(repairLaunchAgentBootstrap).not.toHaveBeenCalled();
    expect(probeGateway).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(4200, "SIGUSR1");
    expect(runServiceRestart).toHaveBeenCalledTimes(1);
  });

  it("restart recovery hook falls back to unmanaged restart when launchd repair fails", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    repairLaunchAgentBootstrap.mockResolvedValueOnce({ ok: false, detail: "boom" });
    findGatewayPidsOnPortSync.mockReturnValue([4200]);

    await runDaemonRestart({ json: true });

    const params = runServiceRestart.mock.calls[0]?.[0] as RestartParams | undefined;
    const recovered = await params?.onNotLoaded?.();

    expect(recovered).toEqual({
      result: "restarted",
      message: "Gateway restart signal sent to unmanaged process on port 18789: 4200.",
    });
    expect(repairLaunchAgentBootstrap).toHaveBeenCalledWith({ env: process.env });
    expect(probeGateway).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(4200, "SIGUSR1");
  });

  it("restart recovery hook returns null outside macOS", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    await runDaemonRestart({ json: true });

    const params = runServiceRestart.mock.calls[0]?.[0] as RestartParams | undefined;
    const recovered = await params?.onNotLoaded?.();

    expect(recovered).toBeNull();
    expect(launchAgentPlistExists).not.toHaveBeenCalled();
    expect(repairLaunchAgentBootstrap).not.toHaveBeenCalled();
    expect(runServiceRestart).toHaveBeenCalledTimes(1);
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
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    findGatewayPidsOnPortSync.mockReturnValue([4200, 4200, 4300]);
    mockSpawnSync.mockReturnValue({
      error: null,
      status: 0,
      stdout:
        'CommandLine="C:\\\\Program Files\\\\OpenClaw\\\\openclaw.exe" gateway --port 18789\r\n',
      stderr: "",
    });
    runServiceStop.mockImplementation(async (params: { onNotLoaded?: () => Promise<unknown> }) => {
      await params.onNotLoaded?.();
    });

    await runDaemonStop({ json: true });

    expect(findGatewayPidsOnPortSync).toHaveBeenCalledWith(18789);
    expect(killSpy).toHaveBeenCalledWith(4200, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(4300, "SIGTERM");
  });

  it("signals a single unmanaged gateway process on restart", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    findGatewayPidsOnPortSync.mockReturnValue([4200]);
    mockSpawnSync.mockReturnValue({
      error: null,
      status: 0,
      stdout:
        'CommandLine="C:\\\\Program Files\\\\OpenClaw\\\\openclaw.exe" gateway --port 18789\r\n',
      stderr: "",
    });
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
    expect(probeGateway).toHaveBeenCalledTimes(1);
    expect(waitForGatewayHealthyListener).toHaveBeenCalledTimes(1);
    expect(waitForGatewayHealthyRestart).not.toHaveBeenCalled();
    expect(terminateStaleGatewayPids).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
  });

  it("fails unmanaged restart when multiple gateway listeners are present", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    findGatewayPidsOnPortSync.mockReturnValue([4200, 4300]);
    mockSpawnSync.mockReturnValue({
      error: null,
      status: 0,
      stdout:
        'CommandLine="C:\\\\Program Files\\\\OpenClaw\\\\openclaw.exe" gateway --port 18789\r\n',
      stderr: "",
    });
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

  it("fails unmanaged restart when the running gateway has commands.restart disabled", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    findGatewayPidsOnPortSync.mockReturnValue([4200]);
    probeGateway.mockResolvedValue({
      ok: true,
      configSnapshot: { commands: { restart: false } },
    });
    isRestartEnabled.mockReturnValue(false);
    runServiceRestart.mockImplementation(
      async (params: RestartParams & { onNotLoaded?: () => Promise<unknown> }) => {
        await params.onNotLoaded?.();
        return true;
      },
    );

    await expect(runDaemonRestart({ json: true })).rejects.toThrow(
      "Gateway restart is disabled in the running gateway config",
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
