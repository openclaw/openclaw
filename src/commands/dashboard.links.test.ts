import { beforeEach, describe, expect, it, vi } from "vitest";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const resolveGatewayPortMock = vi.hoisted(() => vi.fn());
const resolveControlUiLinksMock = vi.hoisted(() => vi.fn());
const detectBrowserOpenSupportMock = vi.hoisted(() => vi.fn());
const openUrlMock = vi.hoisted(() => vi.fn());
const formatControlUiSshHintMock = vi.hoisted(() => vi.fn());
const copyToClipboardMock = vi.hoisted(() => vi.fn());
const resolveSecretRefValuesMock = vi.hoisted(() => vi.fn());
const getDaemonStatusSummaryMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

vi.stubGlobal("fetch", fetchMock);

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

vi.mock("../secrets/resolve.js", () => ({
  resolveSecretRefValues: resolveSecretRefValuesMock,
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
  resolveControlUiLinksMock.mockImplementation(
    ({ bind }: { bind?: string; port: number; customBindHost?: string; basePath?: string }) => ({
      httpUrl: bind === "custom" ? "http://10.0.0.5:18789/" : "http://127.0.0.1:18789/",
      wsUrl: bind === "custom" ? "ws://10.0.0.5:18789" : "ws://127.0.0.1:18789",
    }),
  );
  resolveSecretRefValuesMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
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
  beforeEach(async () => {
    vi.resetModules();
    ({ dashboardCommand } = await import("./dashboard.js"));
    resetRuntime();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    readConfigFileSnapshotMock.mockClear();
    resolveGatewayPortMock.mockClear();
    resolveControlUiLinksMock.mockClear();
    detectBrowserOpenSupportMock.mockClear();
    openUrlMock.mockClear();
    formatControlUiSshHintMock.mockClear();
    copyToClipboardMock.mockClear();
    getDaemonStatusSummaryMock.mockClear();
    fetchMock.mockClear();
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

    expect(fetchMock).not.toHaveBeenCalled();
    expect(detectBrowserOpenSupportMock).not.toHaveBeenCalled();
    expect(openUrlMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      "Browser launch disabled (--no-open). Use the URL above.",
    );
  });

  it("uses the resolved dashboard host for the preflight health probe", async () => {
    mockSnapshot("abc123", { bind: "custom", customBindHost: "10.0.0.5" });
    copyToClipboardMock.mockResolvedValue(true);
    detectBrowserOpenSupportMock.mockResolvedValue({ ok: true });
    openUrlMock.mockResolvedValue(true);

    await dashboardCommand(runtime);

    expect(resolveControlUiLinksMock).toHaveBeenNthCalledWith(1, {
      port: 18789,
      bind: "custom",
      customBindHost: "10.0.0.5",
      basePath: undefined,
    });
    expect(resolveControlUiLinksMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://10.0.0.5:18789/healthz",
      expect.objectContaining({ method: "HEAD", redirect: "manual" }),
    );
    expect(openUrlMock).toHaveBeenCalledWith("http://10.0.0.5:18789/#token=abc123");
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
    fetchMock.mockRejectedValue(new Error("connect failed: ECONNREFUSED 127.0.0.1:18789"));
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

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18789/healthz",
      expect.objectContaining({ method: "HEAD", redirect: "manual" }),
    );
    expect(copyToClipboardMock).not.toHaveBeenCalled();
    expect(openUrlMock).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      "Gateway is not reachable at http://127.0.0.1:18789/healthz (connect failed: ECONNREFUSED 127.0.0.1:18789).",
    );
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("Gateway mode is unset"));
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Gateway service is not installed"),
    );
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("Fix reachability first"));
  });

  it("avoids the mode-unset hint when the config file is missing", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      path: "/tmp/openclaw.json",
      exists: false,
      raw: "",
      parsed: null,
      valid: false,
      config: {},
      issues: [],
      legacyIssues: [],
    });
    resolveGatewayPortMock.mockReturnValue(18789);
    resolveControlUiLinksMock.mockImplementation(
      ({ bind }: { bind?: string; port: number; customBindHost?: string; basePath?: string }) => ({
        httpUrl: "http://127.0.0.1:18789/",
        wsUrl: bind === "loopback" ? "ws://127.0.0.1:18789" : "ws://10.0.0.5:18789",
      }),
    );
    fetchMock.mockRejectedValue(new Error("connect failed: ECONNREFUSED 127.0.0.1:18789"));
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

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18789/healthz",
      expect.objectContaining({ method: "HEAD", redirect: "manual" }),
    );
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("Missing config"));
    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("Gateway mode is unset"));
  });
});
