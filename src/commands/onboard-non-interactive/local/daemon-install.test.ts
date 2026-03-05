import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceInstall = vi.fn().mockResolvedValue(undefined);
const serviceIsLoaded = vi.fn().mockResolvedValue(false);
const isSystemdUserServiceAvailableMock = vi.fn().mockResolvedValue(true);
const buildGatewayInstallPlanMock = vi.fn().mockResolvedValue({
  programArguments: ["/usr/bin/node", "/path/to/dist/index.js", "gateway", "--port", "18789"],
  workingDirectory: undefined,
  environment: { OPENCLAW_GATEWAY_PORT: "18789" },
});
const ensureSystemdUserLingerNonInteractiveMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../../../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    label: "openclaw-gateway",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    install: serviceInstall,
    isLoaded: serviceIsLoaded,
  }),
}));

vi.mock("../../../daemon/systemd.js", () => ({
  isSystemdUserServiceAvailable: () => isSystemdUserServiceAvailableMock(),
}));

vi.mock("../../daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: (params: unknown) => buildGatewayInstallPlanMock(params),
  gatewayInstallErrorHint: () => "Tip: rerun `openclaw gateway install` after fixing the error.",
}));

vi.mock("../../systemd-linger.js", () => ({
  ensureSystemdUserLingerNonInteractive: (params: unknown) =>
    ensureSystemdUserLingerNonInteractiveMock(params),
}));

const { installGatewayDaemonNonInteractive } = await import("./daemon-install.js");

function makeRuntime() {
  const logs: string[] = [];
  const errors: string[] = [];
  let exitCode: number | undefined;
  return {
    log: (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    },
    error: (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    },
    exit: (code: number) => {
      exitCode = code;
    },
    logs,
    errors,
    get exitCode() {
      return exitCode;
    },
  };
}

describe("installGatewayDaemonNonInteractive", () => {
  const baseConfig = {};
  const port = 18789;
  const gatewayToken = "tok_test_abc";

  beforeEach(() => {
    vi.clearAllMocks();
    isSystemdUserServiceAvailableMock.mockResolvedValue(true);
    buildGatewayInstallPlanMock.mockResolvedValue({
      programArguments: ["/usr/bin/node", "/path/to/dist/index.js", "gateway", "--port", "18789"],
      workingDirectory: undefined,
      environment: { OPENCLAW_GATEWAY_PORT: "18789" },
    });
    serviceInstall.mockResolvedValue(undefined);
    ensureSystemdUserLingerNonInteractiveMock.mockResolvedValue(undefined);
  });

  it("returns early when installDaemon is false", async () => {
    const runtime = makeRuntime();
    await installGatewayDaemonNonInteractive({
      nextConfig: baseConfig,
      opts: { installDaemon: false },
      runtime,
      port,
      gatewayToken,
    });
    expect(serviceInstall).not.toHaveBeenCalled();
    expect(buildGatewayInstallPlanMock).not.toHaveBeenCalled();
  });

  it("returns early when installDaemon is undefined", async () => {
    const runtime = makeRuntime();
    await installGatewayDaemonNonInteractive({
      nextConfig: baseConfig,
      opts: {},
      runtime,
      port,
      gatewayToken,
    });
    expect(serviceInstall).not.toHaveBeenCalled();
  });

  it("installs the daemon service when installDaemon is true", async () => {
    const runtime = makeRuntime();
    await installGatewayDaemonNonInteractive({
      nextConfig: baseConfig,
      opts: { installDaemon: true },
      runtime,
      port,
      gatewayToken,
    });
    expect(buildGatewayInstallPlanMock).toHaveBeenCalledWith(
      expect.objectContaining({ port, token: gatewayToken }),
    );
    expect(serviceInstall).toHaveBeenCalledTimes(1);
    expect(serviceInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        programArguments: expect.arrayContaining([expect.any(String)]),
        environment: expect.any(Object),
      }),
    );
  });

  it("calls ensureSystemdUserLingerNonInteractive after successful install", async () => {
    const runtime = makeRuntime();
    await installGatewayDaemonNonInteractive({
      nextConfig: baseConfig,
      opts: { installDaemon: true },
      runtime,
      port,
    });
    expect(ensureSystemdUserLingerNonInteractiveMock).toHaveBeenCalledWith(
      expect.objectContaining({ runtime }),
    );
  });

  it("logs error and hint when service install fails, does not throw", async () => {
    const runtime = makeRuntime();
    serviceInstall.mockRejectedValueOnce(new Error("launchctl failed"));
    await installGatewayDaemonNonInteractive({
      nextConfig: baseConfig,
      opts: { installDaemon: true },
      runtime,
      port,
    });
    expect(runtime.errors).toContain("Gateway service install failed: Error: launchctl failed");
    expect(runtime.logs.some((l) => l.includes("Tip:"))).toBe(true);
    // Does not call linger after install failure
    expect(ensureSystemdUserLingerNonInteractiveMock).not.toHaveBeenCalled();
  });

  it("errors and exits when daemon runtime is invalid", async () => {
    const runtime = makeRuntime();
    await installGatewayDaemonNonInteractive({
      nextConfig: baseConfig,
      opts: { installDaemon: true, daemonRuntime: "invalid-runtime" as never },
      runtime,
      port,
    });
    expect(runtime.errors).toContain("Invalid --daemon-runtime (use node or bun)");
    expect(runtime.exitCode).toBe(1);
    expect(serviceInstall).not.toHaveBeenCalled();
  });

  it("skips install on Linux when systemd is unavailable and logs message", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    isSystemdUserServiceAvailableMock.mockResolvedValueOnce(false);

    const runtime = makeRuntime();
    try {
      await installGatewayDaemonNonInteractive({
        nextConfig: baseConfig,
        opts: { installDaemon: true },
        runtime,
        port,
      });
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }

    expect(serviceInstall).not.toHaveBeenCalled();
    expect(runtime.logs).toContain(
      "Systemd user services are unavailable; skipping service install.",
    );
  });

  it("uses node runtime by default when daemonRuntime is not specified", async () => {
    const runtime = makeRuntime();
    await installGatewayDaemonNonInteractive({
      nextConfig: baseConfig,
      opts: { installDaemon: true },
      runtime,
      port,
      gatewayToken,
    });
    expect(buildGatewayInstallPlanMock).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: "node" }),
    );
  });

  it("uses bun runtime when daemonRuntime is bun", async () => {
    const runtime = makeRuntime();
    await installGatewayDaemonNonInteractive({
      nextConfig: baseConfig,
      opts: { installDaemon: true, daemonRuntime: "bun" },
      runtime,
      port,
      gatewayToken,
    });
    expect(buildGatewayInstallPlanMock).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: "bun" }),
    );
  });

  it("passes config into buildGatewayInstallPlan", async () => {
    const runtime = makeRuntime();
    const nextConfig = { gateway: { port: 18789 } };
    await installGatewayDaemonNonInteractive({
      nextConfig,
      opts: { installDaemon: true },
      runtime,
      port,
      gatewayToken,
    });
    expect(buildGatewayInstallPlanMock).toHaveBeenCalledWith(
      expect.objectContaining({ config: nextConfig }),
    );
  });
});
