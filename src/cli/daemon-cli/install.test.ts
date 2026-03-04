import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfig = vi.fn();
const readConfigFileSnapshot = vi.fn();
const writeConfigFile = vi.fn();
const resolveGatewayPort = vi.fn((_cfg?: unknown) => 18789);
const resolveIsNixMode = vi.fn((_env?: unknown) => false);
const isGatewayDaemonRuntime = vi.fn((_value?: unknown) => true);
const resolveGatewayAuth = vi.fn((_input?: unknown) => ({
  mode: "token",
  token: "cfg-token",
  allowTailscale: false,
}));
const buildGatewayInstallPlan = vi.fn(async (_params?: unknown) => ({
  programArguments: ["node", "cli", "gateway"],
  workingDirectory: process.cwd(),
  environment: {},
}));
const serviceInstall = vi.fn(async () => {});
const serviceIsLoaded = vi.fn(async () => false);
const emit = vi.fn();
const fail = vi.fn((msg: string) => {
  throw new Error(msg);
});

vi.mock("../../config/config.js", () => ({
  loadConfig: () => loadConfig(),
  readConfigFileSnapshot: () => readConfigFileSnapshot(),
  writeConfigFile: (cfg: unknown) => writeConfigFile(cfg),
  resolveGatewayPort: (cfg: unknown) => resolveGatewayPort(cfg),
}));

vi.mock("../../config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/paths.js")>();
  return {
    ...actual,
    resolveIsNixMode: () => resolveIsNixMode(),
  };
});

vi.mock("../../commands/daemon-runtime.js", () => ({
  DEFAULT_GATEWAY_DAEMON_RUNTIME: "node",
  isGatewayDaemonRuntime: (value: string) => isGatewayDaemonRuntime(value),
}));

vi.mock("../../gateway/auth.js", () => ({
  resolveGatewayAuth: (input: unknown) => resolveGatewayAuth(input),
}));

vi.mock("../../commands/daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: (params: unknown) => buildGatewayInstallPlan(params),
}));

vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    loadedText: "loaded",
    isLoaded: () => serviceIsLoaded(),
    install: (opts: unknown) => serviceInstall(opts),
  }),
}));

vi.mock("./response.js", () => ({
  createDaemonActionContext: () => ({
    stdout: process.stdout,
    warnings: [] as string[],
    emit,
    fail,
  }),
  buildDaemonServiceSnapshot: () => ({ loaded: false }),
  installDaemonServiceAndEmit: async (params: { install: () => Promise<void> }) => {
    await params.install();
  },
}));

const runtimeLog = vi.fn();

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: (...args: unknown[]) => runtimeLog(...args),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../command-format.js", () => ({
  formatCliCommand: (s: string) => s,
}));

const { runDaemonInstall } = await import("./install.js");

describe("runDaemonInstall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeLog.mockClear();
    loadConfig.mockReturnValue({
      gateway: {
        mode: "remote",
        auth: { mode: "token", token: "cfg-token" },
        tailscale: { mode: "off" },
      },
    });
    readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {
        gateway: {
          mode: "remote",
          auth: { mode: "token", token: "cfg-token" },
          tailscale: { mode: "off" },
        },
      },
    });
  });

  it("forces gateway.mode to local during install when config is remote", async () => {
    await runDaemonInstall({});

    expect(writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway: expect.objectContaining({ mode: "local" }),
      }),
    );
    expect(runtimeLog).toHaveBeenCalledWith(
      "Gateway install requires local mode; switching gateway.mode from remote to local.",
    );
    expect(serviceInstall).toHaveBeenCalledTimes(1);
  });

  it("does not rewrite mode when gateway.mode is unset", async () => {
    loadConfig.mockReturnValueOnce({ gateway: {} });

    await runDaemonInstall({});

    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(serviceInstall).toHaveBeenCalledTimes(1);
  });
});
