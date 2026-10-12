// Dashboard command tests cover dashboard URL selection, gateway bind modes, and runtime output.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBindMode } from "../config/types.gateway.js";
import { dashboardCommand } from "./dashboard.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  resolveGatewayPort: vi.fn(),
  resolveControlUiLinks: vi.fn(),
  copyToClipboard: vi.fn(),
  issueDeviceBootstrapToken: vi.fn(),
  openUrl: vi.fn(),
  inspectPortUsage: vi.fn(),
  ensureDashboardGatewayReady: vi.fn(),
  waitForControlUiDocument: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  resolveGatewayPort: mocks.resolveGatewayPort,
}));

vi.mock("./onboard-helpers.js", () => ({
  resolveControlUiLinks: mocks.resolveControlUiLinks,
  detectBrowserOpenSupport: vi.fn(),
  openUrl: mocks.openUrl,
  formatControlUiSshHint: vi.fn(() => "ssh hint"),
}));

vi.mock("../infra/clipboard.js", () => ({
  copyToClipboard: mocks.copyToClipboard,
}));

vi.mock("../infra/device-bootstrap.js", () => ({
  issueDeviceBootstrapToken: mocks.issueDeviceBootstrapToken,
}));

vi.mock("../infra/ports-inspect.js", () => ({
  inspectPortUsage: mocks.inspectPortUsage,
}));

vi.mock("./gateway-readiness.js", () => ({
  ensureDashboardGatewayReady: mocks.ensureDashboardGatewayReady,
}));

vi.mock("./control-ui-handoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./control-ui-handoff.js")>()),
  waitForControlUiDocument: mocks.waitForControlUiDocument,
}));

const runtime = createTestRuntime();

type SnapshotParams = {
  token?: string;
  bind?: GatewayBindMode;
  customBindHost?: string;
  tlsEnabled?: boolean;
};

function createSnapshot(params?: SnapshotParams) {
  const token = params?.token ?? "abc123";
  const gateway = {
    auth: { token },
    bind: params?.bind,
    customBindHost: params?.customBindHost,
    ...(params?.tlsEnabled === undefined ? {} : { tls: { enabled: params.tlsEnabled } }),
  };
  return {
    path: "/tmp/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: {},
    valid: true,
    config: {
      gateway,
    },
    issues: [],
    legacyIssues: [],
  };
}

function mockSnapshot(params?: SnapshotParams) {
  mocks.readConfigFileSnapshot.mockResolvedValue(createSnapshot(params));
  mocks.resolveGatewayPort.mockReturnValue(18789);
  mocks.resolveControlUiLinks.mockReturnValue({
    httpUrl: "http://127.0.0.1:18789/",
    wsUrl: "ws://127.0.0.1:18789",
  });
  mocks.copyToClipboard.mockResolvedValue(true);
}

function mockSpecificDashboardLinks(params: {
  bind: "custom" | "tailnet";
  host: string;
  tlsEnabled?: boolean;
}) {
  const scheme = params.tlsEnabled ? { http: "https", ws: "wss" } : { http: "http", ws: "ws" };
  mocks.resolveControlUiLinks.mockImplementation(({ bind }: { bind: GatewayBindMode }) =>
    bind === params.bind
      ? {
          httpUrl: `${scheme.http}://${params.host}:18789/`,
          wsUrl: `${scheme.ws}://${params.host}:18789`,
        }
      : { httpUrl: "http://127.0.0.1:18789/", wsUrl: "ws://127.0.0.1:18789" },
  );
}

function mockAliasOwnership(host: string, loopbackPid = 4242) {
  mocks.inspectPortUsage.mockResolvedValue({
    port: 18789,
    status: "busy",
    listeners: [
      { pid: 4242, commandLine: "openclaw-gateway", address: `${host}:18789` },
      { pid: loopbackPid, commandLine: "openclaw-gateway", address: "127.0.0.1:18789" },
    ],
    hints: [],
  });
}

describe("dashboardCommand bind selection", () => {
  beforeEach(() => {
    mocks.readConfigFileSnapshot.mockClear();
    mocks.resolveGatewayPort.mockClear();
    mocks.resolveControlUiLinks.mockClear();
    mocks.copyToClipboard.mockClear();
    mocks.issueDeviceBootstrapToken.mockReset();
    mocks.issueDeviceBootstrapToken.mockResolvedValue({
      token: "browser-bootstrap",
      expiresAtMs: 123_456,
    });
    mocks.openUrl.mockClear();
    mocks.inspectPortUsage.mockReset();
    mocks.ensureDashboardGatewayReady.mockReset();
    mocks.ensureDashboardGatewayReady.mockResolvedValue({
      ready: true,
      status: {},
      recovered: false,
    });
    mocks.waitForControlUiDocument.mockReset();
    mocks.waitForControlUiDocument.mockResolvedValue({ ready: true });
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
  });

  it.each([{ bind: "custom" as const, host: "10.0.0.5", customBindHost: "10.0.0.5" }])(
    "maps plain-http $bind bind to a verified loopback URL",
    async (params) => {
      mockSnapshot({ bind: params.bind, customBindHost: params.customBindHost });
      mockSpecificDashboardLinks(params);
      mockAliasOwnership(params.host);

      await dashboardCommand(runtime, { noOpen: true });

      expect(mocks.ensureDashboardGatewayReady).toHaveBeenCalledWith(
        expect.objectContaining({
          probeUrl: `ws://${params.host}:18789`,
        }),
      );
      expect(mocks.ensureDashboardGatewayReady.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.inspectPortUsage.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      expect(mocks.resolveControlUiLinks).toHaveBeenCalledWith({
        port: 18789,
        bind: "loopback",
        customBindHost: params.customBindHost,
        basePath: undefined,
        tlsEnabled: false,
      });
      expect(mocks.copyToClipboard).toHaveBeenCalledWith(
        "http://127.0.0.1:18789/#bootstrapToken=browser-bootstrap&bootstrapProfile=owner&gatewayUrl=ws%3A%2F%2F127.0.0.1%3A18789",
      );
    },
  );

  it("refuses an authenticated loopback URL owned by a different process", async () => {
    mockSnapshot({ bind: "custom", customBindHost: "10.0.0.5" });
    mockSpecificDashboardLinks({ bind: "custom", host: "10.0.0.5" });
    mockAliasOwnership("10.0.0.5", 4343);

    await dashboardCommand(runtime, { noOpen: true });

    expect(mocks.copyToClipboard).not.toHaveBeenCalled();
    expect(mocks.issueDeviceBootstrapToken).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("refusing to copy or open an authenticated URL"),
    );
    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("Dashboard URL:"));
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it("refuses URL delivery when loopback ownership inspection fails", async () => {
    mockSnapshot({ bind: "custom", customBindHost: "10.0.0.5" });
    mockSpecificDashboardLinks({ bind: "custom", host: "10.0.0.5" });
    mocks.inspectPortUsage.mockRejectedValue(new Error("inspection unavailable"));

    await dashboardCommand(runtime);

    expect(mocks.copyToClipboard).not.toHaveBeenCalled();
    expect(mocks.issueDeviceBootstrapToken).not.toHaveBeenCalled();
    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("Dashboard URL:"));
  });

  it("does not issue browser credentials when the dashboard document is unavailable", async () => {
    mockSnapshot();
    mocks.waitForControlUiDocument.mockResolvedValue({
      ready: false,
      reason: "Control UI assets are missing from the configured root.",
      status: 503,
    });

    await dashboardCommand(runtime);

    expect(mocks.issueDeviceBootstrapToken).not.toHaveBeenCalled();
    expect(mocks.copyToClipboard).not.toHaveBeenCalled();
    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      "Control UI assets are missing from the configured root.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("rejects invalid configuration before probing or issuing browser credentials", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: false,
      path: "/tmp/openclaw.json",
    });

    await dashboardCommand(runtime);

    expect(mocks.ensureDashboardGatewayReady).not.toHaveBeenCalled();
    expect(mocks.issueDeviceBootstrapToken).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("openclaw doctor --fix"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("re-probes a changed endpoint after recovery before URL delivery", async () => {
    mockSnapshot({ bind: "custom", customBindHost: "10.0.0.5" });
    mocks.readConfigFileSnapshot
      .mockResolvedValueOnce(createSnapshot({ bind: "custom", customBindHost: "10.0.0.5" }))
      .mockResolvedValueOnce(createSnapshot({ bind: "custom", customBindHost: "10.0.0.6" }));
    mocks.resolveControlUiLinks.mockImplementation(
      ({ bind, customBindHost }: { bind: GatewayBindMode; customBindHost?: string }) =>
        bind === "custom"
          ? {
              httpUrl: `http://${customBindHost}:18789/`,
              wsUrl: `ws://${customBindHost}:18789`,
            }
          : { httpUrl: "http://127.0.0.1:18789/", wsUrl: "ws://127.0.0.1:18789" },
    );
    mocks.ensureDashboardGatewayReady
      .mockResolvedValueOnce({ ready: true, status: {}, recovered: true })
      .mockResolvedValueOnce({
        ready: false,
        status: {},
        reason: "Gateway probe failed",
        recoverable: false,
      });

    await dashboardCommand(runtime, { noOpen: true, yes: true });

    expect(mocks.ensureDashboardGatewayReady).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ probeUrl: "ws://10.0.0.5:18789" }),
    );
    expect(mocks.ensureDashboardGatewayReady).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        probeUrl: "ws://10.0.0.6:18789",
        allowInstall: false,
        interactive: false,
      }),
    );
    expect(mocks.inspectPortUsage).not.toHaveBeenCalled();
    expect(mocks.copyToClipboard).not.toHaveBeenCalled();
    expect(mocks.issueDeviceBootstrapToken).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("Dashboard URL:"));
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});
