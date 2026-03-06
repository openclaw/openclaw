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
  install: vi.fn(),
  label: "LaunchAgent",
};

const runServiceRestart = vi.fn();
const waitForGatewayHealthyRestart = vi.fn();
const terminateStaleGatewayPids = vi.fn();
const renderRestartDiagnostics = vi.fn(() => ["diag: unhealthy runtime"]);
const resolveGatewayPort = vi.fn(() => 18789);
const loadConfig = vi.fn(() => ({}));
const collectConfigServiceEnvVars = vi.fn(() => ({}));
const buildServiceEnvironment = vi.fn(() => ({
  OPENCLAW_GATEWAY_PORT: "18789",
  OPENCLAW_GATEWAY_TOKEN: "tok",
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => loadConfig(),
  resolveGatewayPort,
}));
vi.mock("../../config/env-vars.js", () => ({
  collectConfigServiceEnvVars: (...args: unknown[]) => collectConfigServiceEnvVars(...args),
}));

vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => service,
}));
vi.mock("../../daemon/service-env.js", () => ({
  buildServiceEnvironment: (...args: unknown[]) => buildServiceEnvironment(...args),
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
    service.install.mockClear();
    runServiceRestart.mockClear();
    waitForGatewayHealthyRestart.mockClear();
    terminateStaleGatewayPids.mockClear();
    renderRestartDiagnostics.mockClear();
    resolveGatewayPort.mockClear();
    loadConfig.mockClear();
    collectConfigServiceEnvVars.mockClear();
    buildServiceEnvironment.mockClear();
    service.label = "LaunchAgent";

    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "--port", "18789"],
      workingDirectory: "/tmp/openclaw",
      environment: {
        OPENCLAW_GATEWAY_PORT: "18789",
        OPENCLAW_GATEWAY_TOKEN: "tok",
      },
    });

    runServiceRestart.mockImplementation(async (params: RestartParams) => {
      const fail = (message: string, hints?: string[]) => {
        const err = new Error(message) as Error & { hints?: string[] };
        err.hints = hints;
        throw err;
      };
      const context = {
        json: Boolean(params.opts?.json),
        stdout: process.stdout,
        warnings: [],
        fail,
      };
      await params.preRestartCheck?.(context);
      await params.postRestartCheck?.({
        ...context,
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

  it("refreshes launch agent env before restart when config env changes", async () => {
    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "--port", "18789"],
      workingDirectory: "/tmp/openclaw",
      environment: {
        OPENCLAW_GATEWAY_PORT: "18789",
        OPENCLAW_GATEWAY_TOKEN: "tok",
        MAIL_API_KEY: "old",
      },
    });
    collectConfigServiceEnvVars.mockReturnValueOnce({ MAIL_API_KEY: "new" });
    waitForGatewayHealthyRestart.mockResolvedValue({
      healthy: true,
      staleGatewayPids: [],
      runtime: { status: "running" },
      portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
    });

    const result = await runDaemonRestart({ json: true });

    expect(result).toBe(true);
    expect(service.install).toHaveBeenCalledTimes(1);
    expect(service.install).toHaveBeenCalledWith(
      expect.objectContaining({
        programArguments: ["openclaw", "gateway", "--port", "18789"],
        environment: expect.objectContaining({
          MAIL_API_KEY: "new",
          OPENCLAW_GATEWAY_PORT: "18789",
          OPENCLAW_GATEWAY_TOKEN: "tok",
        }),
      }),
    );
  });

  it("skips env refresh when not using launch agent service", async () => {
    service.label = "systemd";
    waitForGatewayHealthyRestart.mockResolvedValue({
      healthy: true,
      staleGatewayPids: [],
      runtime: { status: "running" },
      portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
    });

    const result = await runDaemonRestart({ json: true });

    expect(result).toBe(true);
    expect(service.install).not.toHaveBeenCalled();
  });

  it("skips launch agent env refresh when plist env already matches", async () => {
    collectConfigServiceEnvVars.mockReturnValueOnce({});
    buildServiceEnvironment.mockReturnValueOnce({
      OPENCLAW_GATEWAY_PORT: "18789",
      OPENCLAW_GATEWAY_TOKEN: "tok",
    });
    waitForGatewayHealthyRestart.mockResolvedValue({
      healthy: true,
      staleGatewayPids: [],
      runtime: { status: "running" },
      portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
    });

    const result = await runDaemonRestart({ json: true });

    expect(result).toBe(true);
    expect(service.install).not.toHaveBeenCalled();
  });
});
