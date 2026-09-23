import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isContainerEnvironment: vi.fn(() => false),
  readGatewayServiceState: vi.fn(),
  resolveNodeRuntimeInfo:
    vi.fn<typeof import("../daemon/runtime-paths.js").resolveNodeRuntimeInfo>(),
  resolveGatewayService: vi.fn((): { label: string; managementUnsupportedReason?: string } => ({
    label: "openclaw-gateway",
  })),
}));

vi.mock("../daemon/service.js", () => ({
  readGatewayServiceState: mocks.readGatewayServiceState,
  resolveGatewayService: mocks.resolveGatewayService,
}));

vi.mock("../daemon/runtime-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/runtime-paths.js")>()),
  resolveNodeRuntimeInfo: mocks.resolveNodeRuntimeInfo,
}));

vi.mock("../infra/container-environment.js", () => ({
  isContainerEnvironment: mocks.isContainerEnvironment,
}));

vi.mock("../daemon/systemd.js", () => ({
  findInstalledSystemdGatewayScope: vi
    .fn<typeof import("../daemon/systemd.js").findInstalledSystemdGatewayScope>()
    .mockResolvedValue(null),
}));

const { collectGatewayDaemonFindings } = await import("./doctor-gateway-daemon.js");

describe("doctor gateway daemon checks", () => {
  beforeEach(() => {
    mocks.resolveNodeRuntimeInfo.mockReset().mockResolvedValue({
      status: "supported",
      version: "26.8.1",
      sqliteVersion: "3.53.4",
      sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
      nodeSharedSqlite: false,
    });
    mocks.isContainerEnvironment.mockReset().mockReturnValue(false);
    mocks.readGatewayServiceState.mockReset().mockResolvedValue({
      installed: true,
      loadState: { status: "loaded" },
      running: true,
      env: {},
      command: { programArguments: ["openclaw", "gateway"], sourcePath: "/tmp/gateway.service" },
      runtime: { status: "running" },
    });
    mocks.resolveGatewayService.mockReset().mockReturnValue({ label: "openclaw-gateway" });
  });

  it("reports native unsupported-management guidance for verified absence", async () => {
    const managementUnsupportedReason =
      "Gateway service management is not supported by this CLI on FreeBSD. Run `openclaw gateway run` as your onboarding account.";
    mocks.resolveGatewayService.mockReturnValueOnce({
      label: "Gateway service",
      managementUnsupportedReason,
    });
    mocks.readGatewayServiceState.mockResolvedValueOnce({
      installed: false,
      loadState: { status: "not-loaded" },
      running: false,
      env: {},
      command: null,
      runtime: { status: "stopped", missingUnit: true },
    });
    await expect(collectGatewayDaemonFindings({ cfg: { gateway: {} } })).resolves.toEqual([
      {
        checkId: "core/doctor/gateway-daemon",
        severity: "warning",
        message: "Gateway service is not installed.",
        path: "gateway.mode",
        target: "Gateway service",
        fixHint: managementUnsupportedReason,
      },
    ]);
  });

  it.each([
    {
      label: "missing",
      installed: false,
      loadState: "not-loaded",
      runtimeStatus: "stopped",
      message: "Gateway service is not installed.",
      path: "gateway.mode",
      fixHint: "Run `openclaw gateway install` to install the service.",
    },
    {
      label: "installed but not loaded",
      installed: true,
      loadState: "not-loaded",
      runtimeStatus: "stopped",
      message: "Gateway service is installed but not loaded.",
      path: "/tmp/gateway.service",
      fixHint: "Start the installed service with `openclaw gateway start`.",
    },
    {
      label: "loaded with unconfirmed runtime",
      installed: true,
      loadState: "loaded",
      runtimeStatus: "unknown",
      message: "Gateway service runtime is unknown, not running.",
      path: "/tmp/gateway.service",
      fixHint:
        "Run `openclaw gateway status --deep` to inspect the service before choosing a recovery action.",
    },
  ])("reports actionable advice for a $label local gateway daemon", async (entry) => {
    mocks.readGatewayServiceState.mockResolvedValueOnce({
      installed: entry.installed,
      loadState: { status: entry.loadState },
      running: false,
      env: {},
      command: entry.installed
        ? { programArguments: ["openclaw", "gateway"], sourcePath: "/tmp/gateway.service" }
        : null,
      runtime: { status: entry.runtimeStatus },
    });

    await expect(
      collectGatewayDaemonFindings({ cfg: { gateway: { mode: "local" } } }),
    ).resolves.toEqual([
      {
        checkId: "core/doctor/gateway-daemon",
        severity: "warning",
        message: entry.message,
        path: entry.path,
        target: "openclaw-gateway",
        fixHint: entry.fixHint,
      },
    ]);
  });

  it("skips daemon findings for remote gateway mode", async () => {
    await expect(
      collectGatewayDaemonFindings({ cfg: { gateway: { mode: "remote" } } }),
    ).resolves.toEqual([]);

    expect(mocks.readGatewayServiceState).not.toHaveBeenCalled();
  });

  it.each([
    { version: "26.8.1", text: false, status: "unsupported" as const, severity: "warning" },
    { version: "24.15.0", text: true, status: "supported" as const, severity: "info" },
  ])(
    "reports recorded Node $version capabilities as $severity",
    async ({ version, text, status, severity }) => {
      const message = text
        ? `Node ${version}: unsupported version, capability probe passed.`
        : `Node ${version}: node:sqlite truncates TEXT at embedded NUL (nodejs/node#61954)`;
      mocks.readGatewayServiceState.mockResolvedValueOnce({
        installed: true,
        loadState: { status: "loaded" },
        running: true,
        env: {},
        command: {
          programArguments: ["/opt/runtime/bin/node", "gateway"],
          sourcePath: "/tmp/gateway.service",
        },
        runtime: { status: "running" },
      });
      mocks.resolveNodeRuntimeInfo.mockResolvedValue({
        status,
        version,
        sqliteVersion: "3.53.4",
        sqliteProbe: { available: true, version: "3.53.4", text, blob: true, json: true },
        nodeSharedSqlite: false,
        ...(text ? { note: message } : { capabilityError: message }),
      });

      await expect(
        collectGatewayDaemonFindings({ cfg: { gateway: { mode: "local" } } }),
      ).resolves.toEqual([
        expect.objectContaining({
          checkId: "core/doctor/gateway-daemon",
          severity,
          message,
          target: "/opt/runtime/bin/node",
          ...(severity === "warning" ? { fixHint: expect.stringContaining("nvm install 26") } : {}),
        }),
      ]);
    },
  );

  it("skips host-service findings for a container without an OpenClaw service", async () => {
    mocks.isContainerEnvironment.mockReturnValue(true);

    await expect(
      collectGatewayDaemonFindings({ cfg: { gateway: { mode: "local" } } }),
    ).resolves.toEqual([]);

    expect(mocks.readGatewayServiceState).not.toHaveBeenCalled();
  });
});
