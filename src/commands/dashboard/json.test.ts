import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonStatus } from "../../cli/daemon-cli/status.gather.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { CONTROL_UI_OWNER_BOOTSTRAP_PROFILE } from "../../shared/device-bootstrap-profile.js";
import { expectNoCalls } from "../../test-utils/mock-call-assertions.js";
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
  openUrlPrivately: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  resolveGatewayPort: vi.fn(),
  waitForControlUiDocument: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  resolveGatewayPort: mocks.resolveGatewayPort,
}));

vi.mock("../onboard-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../onboard-helpers.js")>()),
  detectBrowserOpenSupport: vi.fn(),
  formatControlUiSshHint: vi.fn(),
}));

vi.mock("../../infra/clipboard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/clipboard.js")>()),
  copyToClipboard: mocks.copyToClipboard,
}));

vi.mock("../../infra/browser-handoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/browser-handoff.js")>()),
  openUrlPrivately: mocks.openUrlPrivately,
}));

vi.mock("../../infra/device-bootstrap.js", () => ({
  issueDeviceBootstrapToken: mocks.issueDeviceBootstrapToken,
}));

vi.mock("../../infra/ports-inspect.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/ports-inspect.js")>()),
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
  },
  port: { port: 18789, status: "free", listeners: [], hints: [] },
  rpc: { ok: false },
  extraServices: [],
} satisfies DaemonStatus;

const runtime = {
  ...createTestRuntime(),
  writeJson: vi.fn(),
  writeStdout: vi.fn(),
};

function mockGateway(gateway: OpenClawConfig["gateway"]) {
  mocks.readConfigFileSnapshot.mockResolvedValue({ valid: true, sourceConfig: { gateway } });
}

function expectJson(value: unknown) {
  expect(runtime.writeJson).toHaveBeenCalledExactlyOnceWith(value, 0);
}

function expectJsonFields(value: Record<string, unknown>) {
  expectJson(expect.objectContaining(value));
}

function expectFailure(reason: string) {
  expectJson({ ok: false, error: { type: "cli_error", message: reason }, reason });
  expect(runtime.exit).toHaveBeenCalledWith(1);
  expectNoCalls(runtime.log, mocks.copyToClipboard, mocks.openUrlPrivately);
  expect(runtime.error).toHaveBeenCalledWith(
    `${reason}\nRun \`openclaw gateway status --deep\` for details, then retry \`openclaw dashboard --json\`.`,
  );
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

describe("dashboardCommand --json", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGateway({ bind: "custom", customBindHost: "10.0.0.5", auth: { token: fakeToken } });
    mocks.resolveGatewayPort.mockReturnValue(18789);
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
    expectNoCalls(runtime.log, runtime.error, mocks.copyToClipboard, mocks.openUrlPrivately);
    expect(mocks.issueDeviceBootstrapToken).toHaveBeenCalledWith({
      profile: CONTROL_UI_OWNER_BOOTSTRAP_PROFILE,
    });
  });

  it("adds the canonical certificate fingerprint for a TLS Gateway", async () => {
    mockGateway({ bind: "loopback", tls: { enabled: true } });
    mocks.waitForControlUiDocument.mockResolvedValue({
      ready: true,
      tlsFingerprint: "ab".repeat(32),
    });

    await dashboardCommand(runtime, { json: true });

    expect(mocks.waitForControlUiDocument.mock.calls[0]?.[0]).toMatchObject({
      url: "https://127.0.0.1:18789/",
      tlsConfig: { enabled: true },
      waitForPending: false,
    });
    expectJsonFields({
      ok: true,
      wsUrl: "wss://127.0.0.1:18789",
      tlsFingerprint: "ab".repeat(32),
    });
  });

  it("adds a plaintext password only for password-authenticated Gateways", async () => {
    mockGateway({ bind: "loopback", auth: { mode: "password", password: fakePassword } });

    await dashboardCommand(runtime, { json: true });

    expectJsonFields({ [gatewayPasswordJsonKey]: fakePassword });
  });

  it("prints JSON and actionable stderr before exiting when not ready", async () => {
    mocks.gatherStatus.mockResolvedValue(stopped);

    await dashboardCommand(runtime, { json: true });

    expectNoCalls(mocks.confirm, mocks.installGateway, mocks.startGateway);
    expectFailure("Gateway is not running.");
    expect(mocks.issueDeviceBootstrapToken).not.toHaveBeenCalled();
  });

  it("fails immediately without issuing a token while assets are preparing", async () => {
    const reason = "Control UI assets are still preparing.";
    mocks.waitForControlUiDocument.mockResolvedValue({ ready: false, reason, status: 503 });
    await dashboardCommand(runtime, { json: true });
    expectFailure(reason);
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
    expectNoCalls(mocks.waitForControlUiDocument, mocks.issueDeviceBootstrapToken);
  });
});
