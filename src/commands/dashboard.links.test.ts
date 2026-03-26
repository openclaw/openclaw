import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const resolveGatewayPortMock = vi.hoisted(() => vi.fn());
const resolveControlUiLinksMock = vi.hoisted(() => vi.fn());
const detectBrowserOpenSupportMock = vi.hoisted(() => vi.fn());
const openUrlMock = vi.hoisted(() => vi.fn());
const formatControlUiSshHintMock = vi.hoisted(() => vi.fn());
const copyToClipboardMock = vi.hoisted(() => vi.fn());
const resolveSecretRefValuesMock = vi.hoisted(() => vi.fn());
const probeGatewayMock = vi.hoisted(() => vi.fn());
const resolveGatewayProbeAuthResolutionMock = vi.hoisted(() => vi.fn());
const getDaemonStatusSummaryMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  resolveGatewayPort: resolveGatewayPortMock,
}));

vi.mock("./onboard-helpers.js", () => ({
  resolveControlUiLinks: resolveControlUiLinksMock,
  detectBrowserOpenSupport: detectBrowserOpenSupportMock,
  openUrl: openUrlMock,
  formatControlUiSshHint: formatControlUiSshHintMock,
}));

vi.mock("../infra/clipboard.js", () => ({
  copyToClipboard: copyToClipboardMock,
}));

vi.mock("../gateway/probe.js", () => ({
  probeGateway: (opts: unknown) => probeGatewayMock(opts),
}));

vi.mock("../secrets/resolve.js", () => ({
  resolveSecretRefValues: resolveSecretRefValuesMock,
}));

vi.mock("./status.gateway-probe.js", () => ({
  resolveGatewayProbeAuthResolution: (cfg: unknown) => resolveGatewayProbeAuthResolutionMock(cfg),
}));

vi.mock("./status.daemon.js", () => ({
  getDaemonStatusSummary: () => getDaemonStatusSummaryMock(),
}));

let dashboardCommand: typeof import("./dashboard.js").dashboardCommand;

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

function resetRuntime() {
  runtime.log.mockClear();
  runtime.error.mockClear();
  runtime.exit.mockClear();
}

function mockSnapshot(token: unknown = "abc", gateway: Record<string, unknown> = {}) {
  readConfigFileSnapshotMock.mockResolvedValue({
    path: "/tmp/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: {},
    valid: true,
    config: { gateway: { auth: { token }, ...gateway } },
    issues: [],
    legacyIssues: [],
  });
  resolveGatewayPortMock.mockReturnValue(18789);
  resolveControlUiLinksMock.mockReturnValue({
    httpUrl: "http://127.0.0.1:18789/",
    wsUrl: "ws://127.0.0.1:18789",
  });
  resolveSecretRefValuesMock.mockReset();
  resolveGatewayProbeAuthResolutionMock.mockResolvedValue({ auth: { token: "abc" } });
  probeGatewayMock.mockResolvedValue({
    ok: true,
    close: null,
    error: null,
  });
  getDaemonStatusSummaryMock.mockResolvedValue({
    label: "LaunchAgent",
    installed: true,
    loaded: true,
    managedByOpenClaw: true,
    externallyManaged: false,
    loadedText: "loaded",
    runtimeShort: "running",
  });
}

describe("dashboardCommand", () => {
  beforeAll(async () => {
    ({ dashboardCommand } = await import("./dashboard.js"));
  });

  beforeEach(() => {
    resetRuntime();
    readConfigFileSnapshotMock.mockClear();
    resolveGatewayPortMock.mockClear();
    resolveControlUiLinksMock.mockClear();
    detectBrowserOpenSupportMock.mockClear();
    openUrlMock.mockClear();
    formatControlUiSshHintMock.mockClear();
    copyToClipboardMock.mockClear();
    probeGatewayMock.mockClear();
    resolveGatewayProbeAuthResolutionMock.mockClear();
    getDaemonStatusSummaryMock.mockClear();
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.CUSTOM_GATEWAY_TOKEN;
  });

  it("opens and copies the dashboard link by default", async () => {
    mockSnapshot("abc123");
    copyToClipboardMock.mockResolvedValue(true);
    detectBrowserOpenSupportMock.mockResolvedValue({ ok: true });
    openUrlMock.mockResolvedValue(true);

    await dashboardCommand(runtime);

    expect(resolveControlUiLinksMock).toHaveBeenCalledWith({
      port: 18789,
      bind: "loopback",
      customBindHost: undefined,
      basePath: undefined,
    });
    expect(copyToClipboardMock).toHaveBeenCalledWith("http://127.0.0.1:18789/#token=abc123");
    expect(openUrlMock).toHaveBeenCalledWith("http://127.0.0.1:18789/#token=abc123");
    expect(runtime.log).toHaveBeenCalledWith(
      "Opened in your browser. Keep that tab to control OpenClaw.",
    );
  });

  it("prints SSH hint when browser cannot open", async () => {
    mockSnapshot("shhhh");
    copyToClipboardMock.mockResolvedValue(false);
    detectBrowserOpenSupportMock.mockResolvedValue({
      ok: false,
      reason: "ssh",
    });
    formatControlUiSshHintMock.mockReturnValue("ssh hint");

    await dashboardCommand(runtime);

    expect(openUrlMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith("ssh hint");
  });

  it("respects --no-open and skips browser attempts", async () => {
    mockSnapshot();
    copyToClipboardMock.mockResolvedValue(true);

    await dashboardCommand(runtime, { noOpen: true });

    expect(detectBrowserOpenSupportMock).not.toHaveBeenCalled();
    expect(openUrlMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      "Browser launch disabled (--no-open). Use the URL above.",
    );
  });

  it("prints non-tokenized URL with guidance when token SecretRef is unresolved", async () => {
    mockSnapshot({
      source: "env",
      provider: "default",
      id: "MISSING_GATEWAY_TOKEN",
    });
    copyToClipboardMock.mockResolvedValue(true);
    detectBrowserOpenSupportMock.mockResolvedValue({ ok: true });
    openUrlMock.mockResolvedValue(true);
    resolveSecretRefValuesMock.mockRejectedValue(new Error("missing env var"));

    await dashboardCommand(runtime);

    expect(copyToClipboardMock).toHaveBeenCalledWith("http://127.0.0.1:18789/");
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Token auto-auth unavailable"),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "gateway.auth.token SecretRef is unresolved (env:default:MISSING_GATEWAY_TOKEN).",
      ),
    );
    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("missing env var"));
  });

  it("keeps URL non-tokenized when token SecretRef is unresolved but env fallback exists", async () => {
    mockSnapshot({
      source: "env",
      provider: "default",
      id: "MISSING_GATEWAY_TOKEN",
    });
    process.env.OPENCLAW_GATEWAY_TOKEN = "fallback-token";
    copyToClipboardMock.mockResolvedValue(true);
    detectBrowserOpenSupportMock.mockResolvedValue({ ok: true });
    openUrlMock.mockResolvedValue(true);
    resolveSecretRefValuesMock.mockRejectedValue(new Error("missing env var"));

    await dashboardCommand(runtime);

    expect(copyToClipboardMock).toHaveBeenCalledWith("http://127.0.0.1:18789/");
    expect(openUrlMock).toHaveBeenCalledWith("http://127.0.0.1:18789/");
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Token auto-auth is disabled for SecretRef-managed"),
    );
    expect(runtime.log).not.toHaveBeenCalledWith(
      expect.stringContaining("Token auto-auth unavailable"),
    );
  });

  it("keeps URL non-tokenized when env-template gateway.auth.token is unresolved", async () => {
    mockSnapshot("${CUSTOM_GATEWAY_TOKEN}");
    copyToClipboardMock.mockResolvedValue(true);
    detectBrowserOpenSupportMock.mockResolvedValue({ ok: true });
    openUrlMock.mockResolvedValue(true);

    await dashboardCommand(runtime);

    expect(copyToClipboardMock).toHaveBeenCalledWith("http://127.0.0.1:18789/");
    expect(openUrlMock).toHaveBeenCalledWith("http://127.0.0.1:18789/");
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "Token auto-auth unavailable: gateway.auth.token SecretRef is unresolved (env:default:CUSTOM_GATEWAY_TOKEN).",
      ),
    );
    expect(runtime.log).not.toHaveBeenCalledWith(
      expect.stringContaining("Token auto-auth is disabled for SecretRef-managed"),
    );
  });

  it("does not copy or open the dashboard when the local gateway is unreachable", async () => {
    mockSnapshot("abc123");
    probeGatewayMock.mockResolvedValue({
      ok: false,
      close: null,
      error: "connect failed: ECONNREFUSED 127.0.0.1:18789",
    });
    getDaemonStatusSummaryMock.mockResolvedValue({
      label: "LaunchAgent",
      installed: false,
      loaded: false,
      managedByOpenClaw: false,
      externallyManaged: false,
      loadedText: "not loaded",
      runtimeShort: null,
    });

    await dashboardCommand(runtime);

    expect(copyToClipboardMock).not.toHaveBeenCalled();
    expect(openUrlMock).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      "Gateway is not reachable at ws://127.0.0.1:18789 (connect failed: ECONNREFUSED 127.0.0.1:18789).",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Gateway mode is unset; local gateway start is blocked. Run openclaw config set gateway.mode local.",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Gateway service is not installed. Run openclaw daemon install.",
    );
    expect(runtime.log).toHaveBeenCalledWith("Fix reachability first: openclaw gateway probe");
  });
});
