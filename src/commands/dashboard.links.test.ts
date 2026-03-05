import { beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardCommand } from "./dashboard.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const resolveGatewayPortMock = vi.hoisted(() => vi.fn());
const resolveControlUiLinksMock = vi.hoisted(() => vi.fn());
const detectBrowserOpenSupportMock = vi.hoisted(() => vi.fn());
const openUrlMock = vi.hoisted(() => vi.fn());
const formatControlUiSshHintMock = vi.hoisted(() => vi.fn());
const copyToClipboardMock = vi.hoisted(() => vi.fn());
const resolveGatewayServiceMock = vi.hoisted(() => vi.fn());
const readGatewayServiceCommandMock = vi.hoisted(() => vi.fn());

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

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: resolveGatewayServiceMock,
}));

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

function mockSnapshot(token = "abc") {
  readConfigFileSnapshotMock.mockResolvedValue({
    path: "/tmp/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: {},
    valid: true,
    config: { gateway: { auth: { token } } },
    issues: [],
    legacyIssues: [],
  });
  resolveGatewayPortMock.mockReturnValue(18789);
  resolveControlUiLinksMock.mockReturnValue({
    httpUrl: "http://127.0.0.1:18789/",
    wsUrl: "ws://127.0.0.1:18789",
  });
}

describe("dashboardCommand", () => {
  beforeEach(() => {
    resetRuntime();
    readConfigFileSnapshotMock.mockClear();
    resolveGatewayPortMock.mockClear();
    resolveControlUiLinksMock.mockClear();
    detectBrowserOpenSupportMock.mockClear();
    openUrlMock.mockClear();
    formatControlUiSshHintMock.mockClear();
    copyToClipboardMock.mockClear();
    resolveGatewayServiceMock.mockClear();
    readGatewayServiceCommandMock.mockClear();
    readGatewayServiceCommandMock.mockResolvedValue(null);
    resolveGatewayServiceMock.mockReturnValue({
      readCommand: readGatewayServiceCommandMock,
    });
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

  it("falls back to service token when config and shell token are missing", async () => {
    const prevGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    const prevLegacyToken = process.env.CLAWDBOT_GATEWAY_TOKEN;
    try {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
      delete process.env.CLAWDBOT_GATEWAY_TOKEN;
      mockSnapshot("");
      readGatewayServiceCommandMock.mockResolvedValue({
        programArguments: ["node", "gateway"],
        environment: { OPENCLAW_GATEWAY_TOKEN: "service-token" },
      });
      copyToClipboardMock.mockResolvedValue(true);

      await dashboardCommand(runtime, { noOpen: true });

      expect(copyToClipboardMock).toHaveBeenCalledWith(
        "http://127.0.0.1:18789/#token=service-token",
      );
    } finally {
      if (prevGatewayToken === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = prevGatewayToken;
      }
      if (prevLegacyToken === undefined) {
        delete process.env.CLAWDBOT_GATEWAY_TOKEN;
      } else {
        process.env.CLAWDBOT_GATEWAY_TOKEN = prevLegacyToken;
      }
    }
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
});
