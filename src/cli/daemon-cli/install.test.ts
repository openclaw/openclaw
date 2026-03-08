import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfig = vi.fn(() => ({
  gateway: {
    auth: {
      mode: "token",
    },
  },
}));
const readConfigFileSnapshot = vi.fn(async () => ({
  exists: true,
  valid: true,
  config: {
    gateway: {
      auth: {
        mode: "token",
      },
    },
  },
}));
const writeConfigFile = vi.fn(async () => {});
const resolveGatewayPort = vi.fn(() => 18789);
const buildGatewayInstallPlan = vi.fn(async () => ({
  programArguments: ["node", "dist/index.js", "gateway"],
  workingDirectory: "/tmp/openclaw",
  environment: { OPENCLAW_GATEWAY_PORT: "18789" },
}));
const installDaemonServiceAndEmit = vi.fn(async ({ install }) => {
  await install();
});
const emit = vi.fn();
const fail = vi.fn();
const service = {
  loadedText: "loaded",
  isLoaded: vi.fn(async () => false),
  install: vi.fn(async () => {}),
};

vi.mock("../../commands/daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: (params: unknown) => buildGatewayInstallPlan(params),
}));

vi.mock("../../commands/daemon-runtime.js", () => ({
  DEFAULT_GATEWAY_DAEMON_RUNTIME: "node",
  isGatewayDaemonRuntime: () => true,
}));

vi.mock("../../commands/onboard-helpers.js", () => ({
  randomToken: () => "generated-token",
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => loadConfig(),
  readConfigFileSnapshot: () => readConfigFileSnapshot(),
  resolveGatewayPort: () => resolveGatewayPort(),
  writeConfigFile: (cfg: unknown) => writeConfigFile(cfg),
}));

vi.mock("../../config/paths.js", () => ({
  resolveIsNixMode: () => false,
}));

vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => service,
}));

vi.mock("../../gateway/auth.js", () => ({
  resolveGatewayAuth: () => ({
    mode: "token",
    token: process.env.OPENCLAW_GATEWAY_TOKEN,
    allowTailscale: false,
  }),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
  },
}));

vi.mock("./response.js", () => ({
  buildDaemonServiceSnapshot: vi.fn(),
  createDaemonActionContext: () => ({
    stdout: process.stdout,
    warnings: [],
    emit,
    fail,
  }),
  installDaemonServiceAndEmit: (params: unknown) => installDaemonServiceAndEmit(params as never),
}));

vi.mock("./shared.js", () => ({
  parsePort: () => undefined,
}));

describe("runDaemonInstall", () => {
  beforeEach(() => {
    loadConfig.mockClear();
    readConfigFileSnapshot.mockClear();
    writeConfigFile.mockClear();
    resolveGatewayPort.mockClear();
    buildGatewayInstallPlan.mockClear();
    installDaemonServiceAndEmit.mockClear();
    emit.mockClear();
    fail.mockClear();
    service.isLoaded.mockClear();
    service.install.mockClear();
    service.isLoaded.mockResolvedValue(false);
    service.install.mockResolvedValue(undefined);
    vi.unstubAllEnvs();
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "env-token");
    vi.stubEnv("CLAWDBOT_GATEWAY_TOKEN", "");
  });

  it("persists env-backed gateway tokens into config before installing the service", async () => {
    const { runDaemonInstall } = await import("./install.js");

    await runDaemonInstall({});

    expect(writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway: expect.objectContaining({
          auth: expect.objectContaining({
            mode: "token",
            token: "env-token",
          }),
        }),
      }),
    );
    expect(buildGatewayInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        token: undefined,
      }),
    );
    expect(service.install).toHaveBeenCalledTimes(1);
    expect(fail).not.toHaveBeenCalled();
  });
});
