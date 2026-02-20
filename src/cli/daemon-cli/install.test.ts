import { beforeEach, describe, expect, it, vi } from "vitest";

const buildGatewayInstallPlan = vi.fn(async (_args?: unknown) => ({
  programArguments: ["/usr/bin/node", "/tmp/openclaw/dist/index.js", "gateway"],
  workingDirectory: "/tmp/openclaw",
  environment: {
    OPENCLAW_BUNDLED_VERSION: "test",
  },
}));

const loadConfig = vi.fn(() => ({
  gateway: {
    auth: {
      mode: "token",
      token: "cfg-token",
    },
    tailscale: {
      mode: "off",
    },
  },
}));

const readConfigFileSnapshot = vi.fn(async () => ({
  exists: false,
  valid: true,
  config: {},
}));

const resolveGatewayPort = vi.fn((_cfg?: unknown) => 18789);
const writeConfigFile = vi.fn(async (_cfg?: unknown) => {});

const resolveIsNixMode = vi.fn((_env?: unknown) => false);
const randomToken = vi.fn(() => "generated-token");
const resolveGatewayAuth = vi.fn((_input?: unknown) => ({
  mode: "token",
  token: "cfg-token",
  allowTailscale: false,
}));

const serviceInstall = vi.fn(async (_args?: unknown) => {});
const serviceIsLoaded = vi.fn(async (_args?: unknown) => false);
const resolveGatewayService = vi.fn(() => ({
  label: "systemd",
  loadedText: "enabled",
  notLoadedText: "disabled",
  install: (args: unknown) => serviceInstall(args),
  uninstall: vi.fn(),
  stop: vi.fn(),
  restart: vi.fn(),
  isLoaded: (args: unknown) => serviceIsLoaded(args),
  readCommand: vi.fn(),
  readRuntime: vi.fn(),
}));

const runtimeLogs: string[] = [];
const defaultRuntime = {
  log: (message: string) => runtimeLogs.push(message),
  error: vi.fn(),
  exit: (code: number) => {
    throw new Error(`__exit__:${code}`);
  },
};

vi.mock("../../commands/daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: (args: unknown) => buildGatewayInstallPlan(args),
}));

vi.mock("../../commands/daemon-runtime.js", () => ({
  DEFAULT_GATEWAY_DAEMON_RUNTIME: "node",
  isGatewayDaemonRuntime: (value: string) => value === "node" || value === "bun",
}));

vi.mock("../../commands/onboard-helpers.js", () => ({
  randomToken: () => randomToken(),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => loadConfig(),
  readConfigFileSnapshot: () => readConfigFileSnapshot(),
  resolveGatewayPort: (cfg: unknown) => resolveGatewayPort(cfg),
  writeConfigFile: (cfg: unknown) => writeConfigFile(cfg),
}));

vi.mock("../../config/paths.js", () => ({
  resolveIsNixMode: (env: unknown) => resolveIsNixMode(env),
}));

vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => resolveGatewayService(),
}));

vi.mock("../../gateway/auth.js", () => ({
  resolveGatewayAuth: (input: unknown) => resolveGatewayAuth(input),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime,
}));

describe("runDaemonInstall", () => {
  beforeEach(() => {
    runtimeLogs.length = 0;
    buildGatewayInstallPlan.mockClear();
    loadConfig.mockClear();
    readConfigFileSnapshot.mockClear();
    resolveGatewayPort.mockClear();
    writeConfigFile.mockClear();
    resolveIsNixMode.mockClear();
    randomToken.mockClear();
    resolveGatewayAuth.mockClear();
    serviceInstall.mockClear();
    serviceIsLoaded.mockClear();
    resolveGatewayService.mockClear();
    serviceIsLoaded.mockResolvedValue(false);
  });

  it("passes normalized systemd kill mode to service install", async () => {
    const { runDaemonInstall } = await import("./install.js");

    await runDaemonInstall({
      json: true,
      force: true,
      systemdKillMode: " MIXED ",
      token: "cli-token",
    });

    const expectedKillMode = process.platform === "linux" ? "mixed" : undefined;
    expect(serviceInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        systemdKillMode: expectedKillMode,
      }),
    );
  });

  it("fails fast on invalid systemd kill mode", async () => {
    const { runDaemonInstall } = await import("./install.js");

    await expect(
      runDaemonInstall({
        json: true,
        systemdKillMode: "bad-mode",
      }),
    ).rejects.toThrow("__exit__:1");

    expect(serviceInstall).not.toHaveBeenCalled();
    const payload = JSON.parse(runtimeLogs.find((line) => line.includes('"action"')) ?? "{}") as {
      error?: string;
    };
    expect(payload.error).toContain("Invalid --systemd-kill-mode");
  });
});
