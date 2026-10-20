import { beforeEach, expect, it, vi } from "vitest";
import type { GatewayBindMode } from "../config/types.gateway.js";
import { dashboardCommand } from "./dashboard.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  resolveGatewayPort: vi.fn(),
  resolveControlUiLinks: vi.fn(),
  copyToClipboard: vi.fn(),
  issueDeviceBootstrapToken: vi.fn(),
  openUrlPrivately: vi.fn(),
  detectBrowserOpenSupport: vi.fn(),
  inspectPortUsage: vi.fn(),
  ensureDashboardGatewayReady: vi.fn(),
  waitForControlUiDocument: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  resolveGatewayPort: mocks.resolveGatewayPort,
}));

vi.mock("./onboard-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./onboard-helpers.js")>()),
  resolveControlUiLinks: mocks.resolveControlUiLinks,
  detectBrowserOpenSupport: mocks.detectBrowserOpenSupport,
  formatControlUiSshHint: vi.fn(() => "ssh hint"),
}));

vi.mock("../infra/clipboard.js", () => ({
  copyToClipboard: mocks.copyToClipboard,
}));

vi.mock("../infra/browser-handoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/browser-handoff.js")>()),
  openUrlPrivately: mocks.openUrlPrivately,
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
  bind?: GatewayBindMode;
  customBindHost?: string;
};

function createSnapshot({ bind, customBindHost }: SnapshotParams = {}) {
  return {
    ...baseConfigSnapshot,
    config: { gateway: { auth: { token: "abc123" }, bind, customBindHost } },
  };
}

function mockSnapshot(params: SnapshotParams = { bind: "custom", customBindHost: "10.0.0.5" }) {
  mocks.readConfigFileSnapshot.mockResolvedValue(createSnapshot(params));
  mocks.resolveGatewayPort.mockReturnValue(18789);
  mocks.resolveControlUiLinks.mockReturnValue(loopbackLinks);
  mocks.copyToClipboard.mockResolvedValue(true);
}

const loopbackLinks = { httpUrl: "http://127.0.0.1:18789/", wsUrl: "ws://127.0.0.1:18789" };

function mockCustomLinks() {
  mocks.resolveControlUiLinks.mockImplementation(({ bind, customBindHost }: SnapshotParams) =>
    bind === "custom"
      ? { httpUrl: `http://${customBindHost}:18789/`, wsUrl: `ws://${customBindHost}:18789` }
      : loopbackLinks,
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

function expectNoCalls(...mocksToCheck: unknown[]) {
  for (const mock of mocksToCheck) {
    expect(mock).not.toHaveBeenCalled();
  }
}

function expectNoCredentials() {
  expectNoCalls(mocks.copyToClipboard, mocks.issueDeviceBootstrapToken);
  expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("Dashboard URL:"));
}

beforeEach(() => {
  for (const mock of [...Object.values(mocks), ...Object.values(runtime)]) {
    mock.mockClear();
  }
  mocks.issueDeviceBootstrapToken
    .mockReset()
    .mockResolvedValue({ token: "browser-bootstrap", expiresAtMs: 123_456 });
  mocks.openUrlPrivately.mockReset().mockResolvedValue(true);
  mocks.detectBrowserOpenSupport.mockReset().mockResolvedValue({ ok: false });
  mocks.inspectPortUsage.mockReset();
  mocks.ensureDashboardGatewayReady
    .mockReset()
    .mockResolvedValue({ ready: true, status: {}, recovered: false });
  mocks.waitForControlUiDocument.mockReset().mockResolvedValue({ ready: true });
  mockSnapshot();
  mockCustomLinks();
});

it("maps plain-http custom bind to a verified loopback URL", async () => {
  mockAliasOwnership("10.0.0.5");

  await dashboardCommand(runtime, { noOpen: true });

  expect(mocks.ensureDashboardGatewayReady).toHaveBeenCalledWith(
    expect.objectContaining({ probeUrl: "ws://10.0.0.5:18789" }),
  );
  expect(mocks.ensureDashboardGatewayReady.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.inspectPortUsage.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
  );
  expect(mocks.resolveControlUiLinks).toHaveBeenCalledWith({
    port: 18789,
    bind: "loopback",
    customBindHost: "10.0.0.5",
    basePath: undefined,
    tlsEnabled: false,
  });
  expect(mocks.copyToClipboard).toHaveBeenCalledWith(
    "http://127.0.0.1:18789/#bootstrapToken=browser-bootstrap&bootstrapProfile=owner&gatewayUrl=ws%3A%2F%2F127.0.0.1%3A18789",
  );
});

it.each(["different process", "inspection failure"])(
  "refuses URL delivery on %s",
  async (cause) => {
    if (cause === "different process") {
      mockAliasOwnership("10.0.0.5", 4343);
    } else {
      mocks.inspectPortUsage.mockRejectedValue(new Error("inspection unavailable"));
    }
    await dashboardCommand(runtime, cause === "different process" ? { noOpen: true } : {});
    expectNoCredentials();
    expect(mocks.openUrlPrivately).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("refusing to copy or open an authenticated URL"),
    );
  },
);

it.each(["document unavailable", "invalid config"])(
  "rejects %s before credentials",
  async (cause) => {
    const missingDocument = cause === "document unavailable";
    const reason = "Control UI assets are missing from the configured root.";
    if (missingDocument) {
      mockSnapshot({});
      mocks.waitForControlUiDocument.mockResolvedValue({ ready: false, reason, status: 503 });
    } else {
      mocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot, valid: false });
    }
    await dashboardCommand(runtime);
    const untouched = missingDocument
      ? [mocks.copyToClipboard, mocks.openUrlPrivately]
      : [mocks.ensureDashboardGatewayReady];
    expectNoCalls(mocks.issueDeviceBootstrapToken, ...untouched);
    expect(runtime.error).toHaveBeenCalledWith(
      missingDocument ? reason : expect.stringContaining("openclaw doctor --fix"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  },
);

it("re-probes a changed endpoint after recovery before URL delivery", async () => {
  mocks.readConfigFileSnapshot
    .mockResolvedValueOnce(createSnapshot({ bind: "custom", customBindHost: "10.0.0.5" }))
    .mockResolvedValueOnce(createSnapshot({ bind: "custom", customBindHost: "10.0.0.6" }));
  mocks.ensureDashboardGatewayReady
    .mockResolvedValueOnce({ ready: true, status: {}, recovered: true })
    .mockResolvedValueOnce({ ready: false, status: {}, reason: "failed", recoverable: false });

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
  expectNoCredentials();
  expectNoCalls(mocks.inspectPortUsage, runtime.exit);
});
