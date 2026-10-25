import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonStatus } from "../cli/daemon-cli/status.gather.js";
import type { GatewayBindMode } from "../config/types.gateway.js";
import { ExitError } from "../runtime.js";
import { dashboardCommand } from "./dashboard.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const readConfigFileSnapshot = vi.hoisted(() => vi.fn());
const resolveGatewayPort = vi.hoisted(() => vi.fn());
const detectBrowserOpenSupport = vi.hoisted(() => vi.fn());
const openUrl = vi.hoisted(() => vi.fn());
const openUrlPrivately = vi.hoisted(() => vi.fn());
const formatControlUiSshHint = vi.hoisted(() => vi.fn());
const copyToClipboard = vi.hoisted(() => vi.fn());
const issueDeviceBootstrapToken = vi.hoisted(() => vi.fn());
const resolveSecretRefValues = vi.hoisted(() => vi.fn());
const gatherStatus = vi.hoisted(() => vi.fn());
const startGateway = vi.hoisted(() => vi.fn());
const waitForControlUiDocument = vi.hoisted(() => vi.fn());
const inspectPortUsage = vi.hoisted(() => vi.fn());

// mock-isolation: Prove listener ownership with synthetic process/port evidence.
vi.mock("../infra/ports-inspect.js", () => ({ inspectPortUsage }));

// mock-isolation: Dashboard links use synthetic config and ports, not operator state.
vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot,
  resolveGatewayPort,
}));

vi.mock("./onboard-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./onboard-helpers.js")>()),
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

vi.mock("../cli/daemon-cli/status.gather.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/daemon-cli/status.gather.js")>()),
  gatherDaemonStatus: gatherStatus,
}));
vi.mock("../cli/daemon-cli/lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/daemon-cli/lifecycle.js")>()),
  runDaemonStart: startGateway,
}));

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
const notReady = {
  service: {
    label: "synthetic service",
    loaded: false,
    loadState: { status: "not-loaded" },
    loadedText: "loaded",
    notLoadedText: "not loaded",
    command: { programArguments: ["openclaw", "gateway", "run"] },
    runtime: { status: "stopped" },
  },
  port: { port: 18789, status: "free", listeners: [], hints: [] },
  rpc: { ok: false, error: "connect ECONNREFUSED 127.0.0.1:18789" },
  extraServices: [],
} satisfies DaemonStatus;
const ready = { ...notReady, rpc: { ok: true } };

type GatewayOptions = {
  controlUi?: { basePath: string };
  tls?: { enabled: boolean };
  bind?: GatewayBindMode;
  customBindHost?: string;
};

function createSnapshot(token: unknown = "abc", options?: GatewayOptions) {
  return { ...baseConfigSnapshot, config: { gateway: { auth: { token }, ...options } } };
}

function mockSnapshot(token: unknown = "abc", options?: GatewayOptions) {
  readConfigFileSnapshot.mockResolvedValue(createSnapshot(token, options));
  resolveSecretRefValues.mockReset();
  resolveGatewayPort.mockReturnValue(18789);
}

afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
  vi.clearAllMocks();
  inspectPortUsage.mockReset();
  openUrlPrivately.mockReset().mockResolvedValue(true);
  runtime.exit.mockReset();
  issueDeviceBootstrapToken
    .mockReset()
    .mockResolvedValue({ token: "browser-bootstrap", expiresAtMs: 123_456 });
  gatherStatus.mockReset().mockResolvedValue(ready);
  startGateway.mockReset();
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
  gatherStatus.mockResolvedValueOnce(notReady);
  const exit = new ExitError(1);
  runtime.exit.mockImplementationOnce(() => {
    throw exit;
  });
  await expect(dashboardCommand(runtime, { json: true })).rejects.toBe(exit);
  expect(runtime.log).toHaveBeenCalledTimes(1);
  expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(runtime.error).toHaveBeenCalledTimes(1);
});

it("does not copy or open when gateway readiness fails", async () => {
  gatherStatus.mockResolvedValueOnce(notReady);

  await dashboardCommand(runtime);

  expect(readConfigFileSnapshot).toHaveBeenCalledTimes(1);
  expectNoCalls(copyToClipboard, openUrl, issueDeviceBootstrapToken);
});

it("fails closed when a browser pairing link cannot be issued", async () => {
  issueDeviceBootstrapToken.mockRejectedValue(new Error("state store unavailable"));

  await dashboardCommand(runtime);

  expectNoCalls(copyToClipboard, openUrl);
  expect(runtime.error).toHaveBeenCalledWith(
    "Could not create a one-time browser pairing link: state store unavailable",
  );
});

function mockBoundSnapshot(
  params: GatewayOptions = { bind: "custom", customBindHost: "10.0.0.5" },
) {
  mockSnapshot("abc123", params);
}

function mockAliasOwnership(host: string, loopbackPid = 4242) {
  inspectPortUsage.mockResolvedValue({
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
  expectNoCalls(copyToClipboard, issueDeviceBootstrapToken);
  expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("Dashboard URL:"));
}

describe("verified custom-bind handoff", () => {
  beforeEach(() => {
    mockBoundSnapshot();
    detectBrowserOpenSupport.mockResolvedValue({ ok: false });
  });

  it("maps plain-http custom bind to a verified loopback URL", async () => {
    mockAliasOwnership("10.0.0.5");

    await dashboardCommand(runtime, { noOpen: true });

    expect(gatherStatus).toHaveBeenCalledWith(
      expect.objectContaining({ rpc: { url: "ws://10.0.0.5:18789" } }),
    );
    expect(gatherStatus.mock.invocationCallOrder[0]).toBeLessThan(
      inspectPortUsage.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(copyToClipboard).toHaveBeenCalledWith(browserUrl);
  });

  it.each(["different process", "inspection failure"])(
    "refuses URL delivery on %s",
    async (cause) => {
      if (cause === "different process") {
        mockAliasOwnership("10.0.0.5", 4343);
      } else {
        inspectPortUsage.mockRejectedValue(new Error("inspection unavailable"));
      }
      await dashboardCommand(runtime, cause === "different process" ? { noOpen: true } : {});
      expectNoCredentials();
      expect(openUrlPrivately).not.toHaveBeenCalled();
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
        mockBoundSnapshot({});
        waitForControlUiDocument.mockResolvedValue({ ready: false, reason, status: 503 });
      } else {
        readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot, valid: false });
      }
      await dashboardCommand(runtime);
      const untouched = missingDocument ? [copyToClipboard, openUrlPrivately] : [gatherStatus];
      expectNoCalls(issueDeviceBootstrapToken, ...untouched);
      expect(runtime.error).toHaveBeenCalledWith(
        missingDocument ? reason : expect.stringContaining("openclaw doctor --fix"),
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
    },
  );

  it("re-probes a changed endpoint after recovery before URL delivery", async () => {
    readConfigFileSnapshot
      .mockResolvedValueOnce(
        createSnapshot("abc123", { bind: "custom", customBindHost: "10.0.0.5" }),
      )
      .mockResolvedValueOnce(
        createSnapshot("abc123", { bind: "custom", customBindHost: "10.0.0.6" }),
      );
    gatherStatus
      .mockResolvedValueOnce(notReady)
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce({
        ...notReady,
        port: { ...notReady.port, status: "busy" },
        rpc: { ok: false, error: "failed" },
      });

    await dashboardCommand(runtime, { noOpen: true, yes: true });

    expect(gatherStatus).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ rpc: { url: "ws://10.0.0.5:18789" } }),
    );
    expect(gatherStatus).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ rpc: { url: "ws://10.0.0.5:18789" } }),
    );
    expect(gatherStatus).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ rpc: { url: "ws://10.0.0.6:18789" } }),
    );
    expect(gatherStatus).toHaveBeenCalledTimes(3);
    expect(startGateway).toHaveBeenCalledExactlyOnceWith({ json: false });
    expectNoCredentials();
    expectNoCalls(inspectPortUsage, runtime.exit);
  });
});
