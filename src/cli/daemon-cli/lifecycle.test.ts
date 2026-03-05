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
  preRestartCheck?: (ctx: RestartPostCheckContext) => Promise<void>;
  postRestartCheck?: (ctx: RestartPostCheckContext) => Promise<void>;
};

const service = {
  readCommand: vi.fn(),
  restart: vi.fn(),
};

const runServiceRestart = vi.fn();
const waitForGatewayHealthyRestart = vi.fn();
const terminateStaleGatewayPids = vi.fn();
const renderRestartDiagnostics = vi.fn(() => ["diag: unhealthy runtime"]);
const resolveGatewayPort = vi.fn(() => 18789);
const loadConfig = vi.fn(() => ({}));
const readConfigFileSnapshot = vi.fn();
const recoverConfigFromBackups = vi.fn();

vi.mock("../../config/config.js", () => ({
  loadConfig: () => loadConfig(),
  resolveGatewayPort,
  readConfigFileSnapshot,
  recoverConfigFromBackups,
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
  runServiceStop: vi.fn(),
  runServiceUninstall: vi.fn(),
}));

describe("runDaemonRestart health checks", () => {
  let runDaemonRestart: (opts?: { json?: boolean }) => Promise<boolean>;

  beforeAll(async () => {
    ({ runDaemonRestart } = await import("./lifecycle.js"));
  });

  beforeEach(() => {
    service.readCommand.mockClear();
    service.restart.mockClear();
    runServiceRestart.mockClear();
    waitForGatewayHealthyRestart.mockClear();
    terminateStaleGatewayPids.mockClear();
    renderRestartDiagnostics.mockClear();
    resolveGatewayPort.mockClear();
    loadConfig.mockClear();
    readConfigFileSnapshot.mockClear();
    recoverConfigFromBackups.mockClear();

    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "--port", "18789"],
      environment: {},
    });
    readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/openclaw.json",
      exists: true,
      raw: '{"gateway":{"mode":"local"}}\n',
      parsed: { gateway: { mode: "local" } },
      resolved: { gateway: { mode: "local" } },
      valid: true,
      config: { gateway: { mode: "local" } },
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
    recoverConfigFromBackups.mockResolvedValue({
      recovered: false,
      configPath: "/tmp/openclaw.json",
      sourceBackupPath: null,
    });

    runServiceRestart.mockImplementation(async (params: RestartParams) => {
      const fail = (message: string, hints?: string[]) => {
        const err = new Error(message) as Error & { hints?: string[] };
        err.hints = hints;
        throw err;
      };
      await params.preRestartCheck?.({
        json: Boolean(params.opts?.json),
        stdout: process.stdout,
        warnings: [],
        fail,
      });
      await params.postRestartCheck?.({
        json: Boolean(params.opts?.json),
        stdout: process.stdout,
        warnings: [],
        fail,
      });
      return true;
    });
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

  it("attempts backup recovery when config is invalid before restart", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/openclaw.json",
      exists: true,
      raw: "{invalid",
      parsed: {},
      resolved: {},
      valid: false,
      config: {},
      issues: [{ path: "gateway.mode", message: "invalid gateway mode" }],
      warnings: [],
      legacyIssues: [],
    });
    recoverConfigFromBackups.mockResolvedValue({
      recovered: true,
      configPath: "/tmp/openclaw.json",
      sourceBackupPath: "/tmp/openclaw.json.bak",
    });
    waitForGatewayHealthyRestart.mockResolvedValue({
      healthy: true,
      staleGatewayPids: [],
      runtime: { status: "running" },
      portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
    });

    const result = await runDaemonRestart({ json: true });

    expect(result).toBe(true);
    expect(recoverConfigFromBackups).toHaveBeenCalledTimes(1);
  });

  it("resolves health-check port after preflight recovery", async () => {
    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway"],
      environment: {},
    });
    resolveGatewayPort.mockReturnValue(18789);
    readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/openclaw.json",
      exists: true,
      raw: "{invalid",
      parsed: {},
      resolved: {},
      valid: false,
      config: {},
      issues: [{ path: "gateway.mode", message: "invalid gateway mode" }],
      warnings: [],
      legacyIssues: [],
    });
    recoverConfigFromBackups.mockImplementation(async () => {
      resolveGatewayPort.mockReturnValue(19999);
      return {
        recovered: true,
        configPath: "/tmp/openclaw.json",
        sourceBackupPath: "/tmp/openclaw.json.bak",
      };
    });
    waitForGatewayHealthyRestart.mockResolvedValue({
      healthy: true,
      staleGatewayPids: [],
      runtime: { status: "running" },
      portUsage: { port: 19999, status: "busy", listeners: [], hints: [] },
    });

    const result = await runDaemonRestart({ json: true });

    expect(result).toBe(true);
    expect(waitForGatewayHealthyRestart).toHaveBeenCalledWith(
      expect.objectContaining({ port: 19999 }),
    );
  });

  it("blocks restart when config is invalid and backup recovery fails", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/openclaw.json",
      exists: true,
      raw: "{invalid",
      parsed: {},
      resolved: {},
      valid: false,
      config: {},
      issues: [{ path: "gateway.mode", message: "invalid gateway mode" }],
      warnings: [],
      legacyIssues: [],
    });
    recoverConfigFromBackups.mockResolvedValue({
      recovered: false,
      configPath: "/tmp/openclaw.json",
      sourceBackupPath: null,
    });

    await expect(runDaemonRestart({ json: true })).rejects.toMatchObject({
      message: "Gateway restart blocked: config invalid (gateway.mode: invalid gateway mode).",
      hints: ["openclaw config validate", "openclaw doctor"],
    });
    expect(waitForGatewayHealthyRestart).not.toHaveBeenCalled();
  });
});
