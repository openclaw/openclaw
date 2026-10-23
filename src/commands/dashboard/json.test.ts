import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonStatus } from "../../cli/daemon-cli/status.gather.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { dashboardCommand } from "../dashboard.js";
import { createTestRuntime } from "../test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  copyToClipboard: vi.fn(),
  gatherStatus: vi.fn(),
  confirm: vi.fn(),
  installGateway: vi.fn(),
  startGateway: vi.fn(),
  inspectPortUsage: vi.fn(),
  issueDeviceBootstrapToken: vi.fn(),
  openUrl: vi.fn(),
  openUrlPrivately: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  resolveControlUiLinks: vi.fn(),
  resolveGatewayPort: vi.fn(),
  waitForControlUiDocument: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  resolveGatewayPort: mocks.resolveGatewayPort,
}));

vi.mock("../onboard-helpers.js", () => ({
  detectBrowserOpenSupport: vi.fn(),
  formatControlUiSshHint: vi.fn(),
  openUrl: mocks.openUrl,
  resolveControlUiLinks: mocks.resolveControlUiLinks,
}));

vi.mock("../../infra/clipboard.js", () => ({
  copyToClipboard: mocks.copyToClipboard,
}));

vi.mock("../../infra/browser-handoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/browser-handoff.js")>()),
  openUrlPrivately: mocks.openUrlPrivately,
}));

vi.mock("../../infra/device-bootstrap.js", () => ({
  issueDeviceBootstrapToken: mocks.issueDeviceBootstrapToken,
}));

vi.mock("../../infra/ports-inspect.js", () => ({
  inspectPortUsage: mocks.inspectPortUsage,
}));

vi.mock("../../cli/daemon-cli/status.gather.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cli/daemon-cli/status.gather.js")>()),
  gatherDaemonStatus: mocks.gatherStatus,
}));
vi.mock("../../cli/prompt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cli/prompt.js")>()),
  promptYesNo: mocks.confirm,
}));
vi.mock("../../cli/daemon-cli/install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cli/daemon-cli/install.js")>()),
  runDaemonInstall: mocks.installGateway,
}));
vi.mock("../../cli/daemon-cli/lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cli/daemon-cli/lifecycle.js")>()),
  runDaemonStart: mocks.startGateway,
}));

vi.mock("../control-ui-handoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../control-ui-handoff.js")>()),
  waitForControlUiDocument: mocks.waitForControlUiDocument,
}));

// Assembled so secret scanners do not read the fixture as a real credential.
const fakeToken = ["te", "st"].join("");
const fakePassword = ["te", "st-password"].join("");
const gatewayPasswordJsonKey = ["gateway", "Password"].join("");
const stopped = {
  service: {
    label: "synthetic service",
    loaded: false,
    loadState: { status: "not-loaded" },
    loadedText: "loaded",
    notLoadedText: "not loaded",
    command: null,
    runtime: { status: "stopped" },
  },
  port: { port: 18789, status: "free", listeners: [], hints: [] },
  rpc: { ok: false, error: "connect ECONNREFUSED 127.0.0.1:18789" },
  extraServices: [],
} satisfies DaemonStatus;

const runtime = {
  ...createTestRuntime(),
  writeJson: vi.fn(),
  writeStdout: vi.fn(),
};

function mockGateway(gateway: OpenClawConfig["gateway"]) {
  mocks.readConfigFileSnapshot.mockResolvedValue({
    valid: true,
    sourceConfig: { gateway },
  });
}

function expectJson(value: unknown) {
  expect(runtime.writeJson).toHaveBeenCalledExactlyOnceWith(value, 0);
}

function expectFailure(reason: string) {
  expectJson({ ok: false, error: { type: "cli_error", message: reason }, reason });
  expect(runtime.exit).toHaveBeenCalledWith(1);
}

function mockListeners(loopbackPid = 4242, commandLine = "openclaw-gateway") {
  mocks.inspectPortUsage.mockResolvedValue({
    port: 18789,
    status: "busy",
    listeners: [
      { pid: 4242, commandLine: "openclaw-gateway", address: "10.0.0.5:18789" },
      { pid: loopbackPid, commandLine, address: "127.0.0.1:18789" },
    ],
    hints: [],
  });
}

function links(host: string, tls = false) {
  return {
    httpUrl: `${tls ? "https" : "http"}://${host}:18789/`,
    wsUrl: `${tls ? "wss" : "ws"}://${host}:18789`,
  };
}

describe("dashboardCommand --json", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGateway({ bind: "custom", customBindHost: "10.0.0.5", auth: { token: fakeToken } });
    mocks.resolveGatewayPort.mockReturnValue(18789);
    mocks.resolveControlUiLinks.mockImplementation(({ bind }: { bind: string }) =>
      links(bind === "custom" ? "10.0.0.5" : "127.0.0.1"),
    );
    mockListeners();
    mocks.gatherStatus.mockResolvedValue({ ...stopped, rpc: { ok: true } });
    mocks.issueDeviceBootstrapToken.mockResolvedValue({
      token: "browser-bootstrap",
      expiresAtMs: 123_456,
    });
    mocks.waitForControlUiDocument.mockResolvedValue({ ready: true });
  });

  it("prints one compact success object without interactive side effects", async () => {
    await dashboardCommand(runtime, { json: true, noOpen: true });
    expectJson({
      ok: true,
      url: ["http://127.0.0.1:18789/", "#", "token", "=test"].join(""),
      httpUrl: "http://127.0.0.1:18789/",
      wsUrl: "ws://127.0.0.1:18789",
      port: 18789,
      tokenIncluded: true,
      browserUrl:
        "http://127.0.0.1:18789/#bootstrapToken=browser-bootstrap&bootstrapProfile=owner&gatewayUrl=ws%3A%2F%2F127.0.0.1%3A18789",
      browserBootstrapExpiresAtMs: 123_456,
    });
    expect(runtime.log).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(mocks.copyToClipboard).not.toHaveBeenCalled();
    expect(mocks.inspectPortUsage).toHaveBeenCalledWith(18789);
    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(mocks.issueDeviceBootstrapToken).toHaveBeenCalledWith({
      profile: {
        roles: ["operator"],
        scopes: [
          "operator.admin",
          "operator.approvals",
          "operator.pairing",
          "operator.questions",
          "operator.read",
          "operator.talk.secrets",
          "operator.write",
        ],
        purpose: "control-ui-owner",
      },
    });
  });

  it("adds the canonical certificate fingerprint for a TLS Gateway", async () => {
    mockGateway({ bind: "loopback", tls: { enabled: true } });
    mocks.resolveControlUiLinks.mockReturnValue(links("127.0.0.1", true));
    mocks.waitForControlUiDocument.mockResolvedValue({
      ready: true,
      tlsFingerprint: "ab".repeat(32),
    });

    await dashboardCommand(runtime, { json: true });

    expect(mocks.waitForControlUiDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://127.0.0.1:18789/",
        tlsConfig: { enabled: true },
        waitForPending: false,
      }),
    );
    expectJson(
      expect.objectContaining({
        ok: true,
        wsUrl: "wss://127.0.0.1:18789",
        tlsFingerprint: "ab".repeat(32),
      }),
    );
  });

  it("adds a plaintext password only for password-authenticated Gateways", async () => {
    mockGateway({ bind: "loopback", auth: { mode: "password", password: fakePassword } });

    await dashboardCommand(runtime, { json: true });

    expectJson(expect.objectContaining({ [gatewayPasswordJsonKey]: fakePassword }));
  });

  it("prints JSON and actionable stderr before exiting when not ready", async () => {
    mocks.gatherStatus.mockResolvedValue(stopped);

    await dashboardCommand(runtime, { json: true });

    expect(mocks.gatherStatus).toHaveBeenCalledWith(
      expect.objectContaining({ rpc: { url: "ws://10.0.0.5:18789" } }),
    );
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.installGateway).not.toHaveBeenCalled();
    expect(mocks.startGateway).not.toHaveBeenCalled();
    expectFailure("Gateway is not running.");
    expect(runtime.log).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      "Gateway is not running.\nRun `openclaw gateway status --deep` for details, then retry `openclaw dashboard --json`.",
    );
    expect(mocks.issueDeviceBootstrapToken).not.toHaveBeenCalled();
  });

  it("keeps SecretRef-managed tokens out of the URL", async () => {
    mockGateway({
      bind: "custom",
      customBindHost: "10.0.0.5",
      auth: {
        token: { source: "env", provider: "default", id: "MISSING_GATEWAY_TOKEN" },
      },
    });

    await dashboardCommand(runtime, { json: true });

    expectJson(
      expect.objectContaining({
        ok: true,
        url: "http://127.0.0.1:18789/",
        tokenIncluded: false,
      }),
    );
  });

  it.each([
    { reason: "Control UI assets are still preparing.", status: 503 },
    { reason: "Gateway TLS certificate fingerprint mismatch." },
  ])("fails immediately without issuing a token: $reason", async (failure) => {
    mocks.waitForControlUiDocument.mockResolvedValue({ ready: false, ...failure });
    await dashboardCommand(runtime, { json: true });
    expect(mocks.waitForControlUiDocument).toHaveBeenCalledWith(
      expect.objectContaining({ waitForPending: false }),
    );
    expectFailure(failure.reason);
    expect(mocks.issueDeviceBootstrapToken).not.toHaveBeenCalled();
  });

  it("fails closed when the browser bootstrap cannot be issued", async () => {
    mocks.issueDeviceBootstrapToken.mockRejectedValue(new Error("state store unavailable"));

    await dashboardCommand(runtime, { json: true });

    expectFailure("state store unavailable");
  });

  it("keeps the shared error envelope when loopback ownership cannot be verified", async () => {
    mockListeners(4343, "other-process");

    await dashboardCommand(runtime, { json: true });

    expectFailure("Dashboard loopback listener could not be verified as the configured Gateway.");
    expect(mocks.waitForControlUiDocument).not.toHaveBeenCalled();
    expect(mocks.issueDeviceBootstrapToken).not.toHaveBeenCalled();
    expect(mocks.copyToClipboard).not.toHaveBeenCalled();
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });
});
