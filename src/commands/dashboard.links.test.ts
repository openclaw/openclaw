import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExitError } from "../runtime.js";
import { dashboardCommand } from "./dashboard.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const readConfigFileSnapshot = vi.hoisted(() => vi.fn());
const resolveGatewayPort = vi.hoisted(() => vi.fn());
const resolveControlUiLinks = vi.hoisted(() => vi.fn());
const detectBrowserOpenSupport = vi.hoisted(() => vi.fn());
const openUrl = vi.hoisted(() => vi.fn());
const openUrlPrivately = vi.hoisted(() => vi.fn());
const formatControlUiSshHint = vi.hoisted(() => vi.fn());
const copyToClipboard = vi.hoisted(() => vi.fn());
const issueDeviceBootstrapToken = vi.hoisted(() => vi.fn());
const resolveSecretRefValues = vi.hoisted(() => vi.fn());
const ensureDashboardGatewayReady = vi.hoisted(() => vi.fn());
const waitForControlUiDocument = vi.hoisted(() => vi.fn());

// mock-isolation: Dashboard links use synthetic config and ports, not operator state.
vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot,
  resolveGatewayPort,
}));

// mock-isolation: Capture link generation and browser handoff without opening a browser.
vi.mock("./onboard-helpers.js", () => ({
  resolveControlUiLinks,
  detectBrowserOpenSupport,
  openUrl,
  formatControlUiSshHint,
}));

vi.mock("../infra/browser-handoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/browser-handoff.js")>()),
  openUrlPrivately,
}));

// mock-isolation: Observe clipboard handoff without changing the system clipboard.
vi.mock("../infra/clipboard.js", () => ({ copyToClipboard }));

// mock-isolation: Issue synthetic bootstrap tokens without creating real device authority.
vi.mock("../infra/device-bootstrap.js", () => ({ issueDeviceBootstrapToken }));

// mock-isolation: Select readiness outcomes without starting or probing a real Gateway.
vi.mock("./gateway-readiness.js", () => ({ ensureDashboardGatewayReady }));

vi.mock("./control-ui-handoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./control-ui-handoff.js")>()),
  waitForControlUiDocument,
}));

// mock-isolation: Resolve synthetic SecretRefs without invoking credential providers.
vi.mock("../secrets/resolve.js", () => ({ resolveSecretRefValues }));

const runtime = createTestRuntime();

function output() {
  return runtime.log.mock.calls.flat().map(String).join("\n");
}

function expectNoLoggedToken(token: string) {
  expect(output()).not.toContain(token);
  expect(output()).not.toContain("#token=");
}

const browserUrl =
  "http://127.0.0.1:18789/#bootstrapToken=browser-bootstrap&bootstrapProfile=owner&gatewayUrl=ws%3A%2F%2F127.0.0.1%3A18789";
const notReady = { ready: false, status: {}, reason: "Gateway is not running.", recoverable: true };

function mockSnapshot(
  token: unknown = "abc",
  gatewayOptions?: {
    controlUi?: { basePath: string };
    tls?: { enabled: boolean };
  },
) {
  readConfigFileSnapshot.mockResolvedValue({
    ...baseConfigSnapshot,
    config: { gateway: { auth: { token }, ...gatewayOptions } },
  });
  resolveGatewayPort.mockReturnValue(18789);
  resolveControlUiLinks.mockReturnValue({
    httpUrl: "http://127.0.0.1:18789/",
    wsUrl: "ws://127.0.0.1:18789",
  });
  resolveSecretRefValues.mockReset();
}

afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
  vi.clearAllMocks();
  openUrlPrivately.mockReset().mockResolvedValue(true);
  runtime.exit.mockReset();
  issueDeviceBootstrapToken
    .mockReset()
    .mockResolvedValue({ token: "browser-bootstrap", expiresAtMs: 123_456 });
  ensureDashboardGatewayReady
    .mockReset()
    .mockResolvedValue({ ready: true, status: {}, recovered: false });
  waitForControlUiDocument.mockReset().mockResolvedValue({ ready: true });
  copyToClipboard.mockResolvedValue(true);
  detectBrowserOpenSupport.mockResolvedValue({ ok: true });
  mockSnapshot();
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.CUSTOM_GATEWAY_TOKEN;
});

it("never logs the gateway token in the dashboard URL (CVE regression)", async () => {
  const secretToken = "super-secret-bearer-token";
  mockSnapshot(secretToken);

  await dashboardCommand(runtime);

  expect(copyToClipboard).toHaveBeenCalledWith(browserUrl);
  expect(openUrlPrivately).toHaveBeenCalledWith(browserUrl);
  expect(openUrl).not.toHaveBeenCalled();

  expectNoLoggedToken(secretToken);
  expect(runtime.log).toHaveBeenCalledWith("Dashboard URL: http://127.0.0.1:18789/");
  expect(runtime.log).toHaveBeenCalledWith(
    "One-time browser pairing included in browser/clipboard URL.",
  );
});

it("preserves Gateway TLS after remote browser delivery fails", async () => {
  vi.stubEnv("SSH_CONNECTION", "192.0.2.1 12345 192.0.2.2 22");
  mockSnapshot("shhhh", {
    controlUi: { basePath: "/control" },
    tls: { enabled: true },
  });
  resolveControlUiLinks.mockReturnValue({
    httpUrl: "https://127.0.0.1:18789/control/",
    wsUrl: "wss://127.0.0.1:18789/control",
  });
  copyToClipboard.mockResolvedValue(false);
  openUrlPrivately.mockResolvedValue(false);
  formatControlUiSshHint.mockReturnValue("ssh hint");

  await dashboardCommand(runtime);

  expect(formatControlUiSshHint).toHaveBeenCalledWith({
    port: 18789,
    basePath: "/control",
    tlsEnabled: true,
  });
  expect(runtime.log).toHaveBeenCalledWith("ssh hint");
});

it("reports opener failure without claiming the host has no GUI", async () => {
  mockSnapshot("shhhh");
  openUrlPrivately.mockResolvedValue(false);

  await dashboardCommand(runtime);

  expect(formatControlUiSshHint).not.toHaveBeenCalled();
  expect(runtime.log).toHaveBeenCalledWith(
    "Browser launch failed. Open the one-time pairing URL copied to clipboard.",
  );
});

it("never passes token to SSH hint (CVE regression — SSH path)", async () => {
  const secretToken = "super-secret-bearer-token";
  mockSnapshot(secretToken);
  copyToClipboard.mockResolvedValue(false);
  detectBrowserOpenSupport.mockResolvedValue({ ok: false, reason: "ssh" });
  formatControlUiSshHint.mockReturnValue("ssh hint without token");

  await dashboardCommand(runtime);

  expect(formatControlUiSshHint).toHaveBeenCalledWith({
    port: 18789,
    basePath: undefined,
    tlsEnabled: false,
  });
  const [sshHintOptions] = formatControlUiSshHint.mock.calls[0] ?? [];
  expect(sshHintOptions).not.toHaveProperty("token");

  expectNoLoggedToken(secretToken);
  expect(openUrl).not.toHaveBeenCalled();
  expect(runtime.log).toHaveBeenCalledWith("ssh hint without token");
  expect(output()).toContain("OPENCLAW_GATEWAY_TOKEN");
  expect(output()).toContain("key `token`");
});

it("guides no-token users to the explicit JSON handoff when clipboard delivery fails", async () => {
  mockSnapshot("");
  copyToClipboard.mockResolvedValue(false);

  await dashboardCommand(runtime, { noOpen: true });

  expect(runtime.log).not.toHaveBeenCalledWith(
    "Browser launch disabled (--no-open). Use the URL above.",
  );
  expect(runtime.log).toHaveBeenCalledWith(
    "One-time pairing URL not delivered. Run `openclaw dashboard --json` and open its `browserUrl` within ten minutes.",
  );
});

it("uses browser bootstrap when the shared-token SecretRef is unresolved", async () => {
  mockSnapshot({ source: "env", provider: "default", id: "MISSING_GATEWAY_TOKEN" });
  resolveSecretRefValues.mockRejectedValue(new Error("missing env var"));

  await dashboardCommand(runtime);

  expect(copyToClipboard).toHaveBeenCalledWith(browserUrl);
  expect(output()).not.toContain("Token auto-auth unavailable");
  expect(output()).not.toContain("missing env var");
});

it("emits one JSON readiness failure before an exiting runtime unwinds", async () => {
  const { reason } = notReady;
  ensureDashboardGatewayReady.mockResolvedValueOnce(notReady);
  const exit = new ExitError(1);
  runtime.exit.mockImplementationOnce(() => {
    throw exit;
  });
  await expect(dashboardCommand(runtime, { json: true })).rejects.toBe(exit);
  expect(runtime.log).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({ ok: false, error: { type: "cli_error", message: reason }, reason }),
  );
  expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(runtime.error).toHaveBeenCalledExactlyOnceWith(
    "Gateway is not running.\nRun `openclaw gateway status --deep` for details, then retry `openclaw dashboard --json`.",
  );
  expect(issueDeviceBootstrapToken).not.toHaveBeenCalled();
});

it("does not copy or open when gateway readiness fails", async () => {
  ensureDashboardGatewayReady.mockResolvedValueOnce(notReady);

  await dashboardCommand(runtime);

  expect(readConfigFileSnapshot).toHaveBeenCalledTimes(1);
  expect(copyToClipboard).not.toHaveBeenCalled();
  expect(openUrl).not.toHaveBeenCalled();
  expect(issueDeviceBootstrapToken).not.toHaveBeenCalled();
});

it("fails closed when a browser pairing link cannot be issued", async () => {
  issueDeviceBootstrapToken.mockRejectedValue(new Error("state store unavailable"));

  await dashboardCommand(runtime);

  expect(copyToClipboard).not.toHaveBeenCalled();
  expect(openUrl).not.toHaveBeenCalled();
  expect(runtime.error).toHaveBeenCalledWith(
    "Could not create a one-time browser pairing link: state store unavailable",
  );
});
