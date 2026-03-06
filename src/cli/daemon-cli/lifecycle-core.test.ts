import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const buildGatewayInstallPlan = vi.fn();
const loadConfig = vi.fn(() => ({
  gateway: {
    auth: {
      token: "config-token",
    },
  },
}));
const resolveGatewayPort = vi.fn(() => 18789);
const resolveGatewayInstallToken = vi.fn(async () => ({
  token: "config-token",
  warnings: [],
  unavailableReason: null,
}));

const runtimeLogs: string[] = [];
const defaultRuntime = {
  log: (message: string) => runtimeLogs.push(message),
  error: vi.fn(),
  exit: (code: number) => {
    throw new Error(`__exit__:${code}`);
  },
};

const service = {
  label: "TestService",
  loadedText: "loaded",
  notLoadedText: "not loaded",
  install: vi.fn(),
  uninstall: vi.fn(),
  stop: vi.fn(),
  isLoaded: vi.fn(),
  readCommand: vi.fn(),
  readRuntime: vi.fn(),
  restart: vi.fn(),
};

vi.mock("../../config/config.js", () => ({
  loadConfig: () => loadConfig(),
}));

vi.mock("../../config/paths.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/paths.js")>("../../config/paths.js");
  return {
    ...actual,
    resolveGatewayPort: (...args: unknown[]) => resolveGatewayPort(...args),
  };
});

vi.mock("../../commands/daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: (...args: unknown[]) => buildGatewayInstallPlan(...args),
}));

vi.mock("../../commands/gateway-install-token.js", () => ({
  resolveGatewayInstallToken: (...args: unknown[]) => resolveGatewayInstallToken(...args),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime,
}));

let runServiceRestart: typeof import("./lifecycle-core.js").runServiceRestart;

describe("runServiceRestart token drift", () => {
  beforeAll(async () => {
    ({ runServiceRestart } = await import("./lifecycle-core.js"));
  });

  beforeEach(() => {
    runtimeLogs.length = 0;
    buildGatewayInstallPlan.mockReset();
    loadConfig.mockReset();
    resolveGatewayPort.mockReset();
    resolveGatewayInstallToken.mockReset();
    loadConfig.mockReturnValue({
      gateway: {
        auth: {
          token: "config-token",
        },
      },
    });
    resolveGatewayPort.mockReturnValue(18789);
    resolveGatewayInstallToken.mockResolvedValue({
      token: "config-token",
      warnings: [],
      unavailableReason: null,
    });
    service.isLoaded.mockClear();
    service.install.mockClear();
    service.readCommand.mockClear();
    service.restart.mockClear();
    service.isLoaded.mockResolvedValue(true);
    service.readCommand.mockResolvedValue({
      programArguments: ["node", "dist/entry.js", "gateway", "--port", "18789"],
      environment: { OPENCLAW_GATEWAY_TOKEN: "service-token" },
    });
    buildGatewayInstallPlan.mockResolvedValue({
      programArguments: ["node", "dist/entry.js", "gateway", "--port", "18789"],
      workingDirectory: "/tmp/openclaw",
      environment: { MAIL_API_KEY: "updated-key", OPENCLAW_GATEWAY_TOKEN: "config-token" },
    });
    service.restart.mockResolvedValue(undefined);
    vi.unstubAllEnvs();
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
    vi.stubEnv("CLAWDBOT_GATEWAY_TOKEN", "");
  });

  it("emits drift warning when enabled", async () => {
    await runServiceRestart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => [],
      opts: { json: true },
      checkTokenDrift: true,
    });

    expect(loadConfig).toHaveBeenCalledTimes(1);
    const jsonLine = runtimeLogs.find((line) => line.trim().startsWith("{"));
    const payload = JSON.parse(jsonLine ?? "{}") as { warnings?: string[] };
    expect(payload.warnings?.[0]).toContain("gateway install --force");
  });

  it("uses env-first token precedence when checking drift", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        auth: {
          token: "config-token",
        },
      },
    });
    service.readCommand.mockResolvedValue({
      environment: { OPENCLAW_GATEWAY_TOKEN: "env-token" },
    });
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "env-token");

    await runServiceRestart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => [],
      opts: { json: true },
      checkTokenDrift: true,
    });

    const jsonLine = runtimeLogs.find((line) => line.trim().startsWith("{"));
    const payload = JSON.parse(jsonLine ?? "{}") as { warnings?: string[] };
    expect(payload.warnings).toBeUndefined();
  });

  it("skips drift warning when disabled", async () => {
    await runServiceRestart({
      serviceNoun: "Node",
      service,
      renderStartHints: () => [],
      opts: { json: true },
    });

    expect(loadConfig).not.toHaveBeenCalled();
    expect(service.readCommand).not.toHaveBeenCalled();
    const jsonLine = runtimeLogs.find((line) => line.trim().startsWith("{"));
    const payload = JSON.parse(jsonLine ?? "{}") as { warnings?: string[] };
    expect(payload.warnings).toBeUndefined();
  });

  it("refreshes LaunchAgent service env from current config before restart", async () => {
    service.label = "LaunchAgent";

    await runServiceRestart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => [],
      opts: { json: true },
    });

    expect(resolveGatewayInstallToken).toHaveBeenCalledTimes(1);
    expect(buildGatewayInstallPlan).toHaveBeenCalledTimes(1);
    expect(service.install).toHaveBeenCalledTimes(1);
    expect(service.restart).not.toHaveBeenCalled();
  });

  it("falls back to service restart for non-LaunchAgent services", async () => {
    service.label = "systemd";

    await runServiceRestart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => [],
      opts: { json: true },
    });

    expect(service.install).not.toHaveBeenCalled();
    expect(service.restart).toHaveBeenCalledTimes(1);
  });
});
