import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardCommand } from "./dashboard.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const resolveGatewayPortMock = vi.hoisted(() => vi.fn());
const resolveControlUiLinksMock = vi.hoisted(() => vi.fn());
const detectBrowserOpenSupportMock = vi.hoisted(() => vi.fn());
const openUrlMock = vi.hoisted(() => vi.fn());
const formatControlUiSshHintMock = vi.hoisted(() => vi.fn());
const probeGatewayReachableMock = vi.hoisted(() => vi.fn());
const waitForGatewayReachableMock = vi.hoisted(() => vi.fn());
const copyToClipboardMock = vi.hoisted(() => vi.fn());
const resolveControlUiRepoRootMock = vi.hoisted(() => vi.fn());
const tryListenOnPortMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  resolveGatewayPort: resolveGatewayPortMock,
}));

vi.mock("./onboard-helpers.js", () => ({
  resolveControlUiLinks: resolveControlUiLinksMock,
  detectBrowserOpenSupport: detectBrowserOpenSupportMock,
  openUrl: openUrlMock,
  formatControlUiSshHint: formatControlUiSshHintMock,
  probeGatewayReachable: probeGatewayReachableMock,
  waitForGatewayReachable: waitForGatewayReachableMock,
}));

vi.mock("../infra/clipboard.js", () => ({
  copyToClipboard: copyToClipboardMock,
}));

vi.mock("../infra/control-ui-assets.js", () => ({
  resolveControlUiRepoRoot: resolveControlUiRepoRootMock,
}));

vi.mock("../infra/ports-probe.js", () => ({
  tryListenOnPort: tryListenOnPortMock,
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: existsSyncMock,
  },
  existsSync: existsSyncMock,
}));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
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

function createMockChild() {
  const child = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.exitCode = null;
  child.kill = vi.fn(() => {
    child.exitCode = 0;
    child.emit("exit", 0);
    return true;
  });
  return child;
}

function mockDevServerExit(code = 0) {
  const child = createMockChild();
  spawnMock.mockReturnValue(child as never);
  setTimeout(() => {
    child.exitCode = code;
    child.emit("exit", code);
  }, 0);
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
    probeGatewayReachableMock.mockReset();
    waitForGatewayReachableMock.mockReset();
    copyToClipboardMock.mockClear();
    resolveControlUiRepoRootMock.mockReset();
    tryListenOnPortMock.mockReset();
    existsSyncMock.mockReset();
    spawnMock.mockReset();
    probeGatewayReachableMock.mockResolvedValue({ ok: true });
    waitForGatewayReachableMock.mockResolvedValue({ ok: true });
    tryListenOnPortMock.mockResolvedValue(undefined);
    existsSyncMock.mockReturnValue(true);
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

  it("starts Vite dev server for `dashboard dev`", async () => {
    mockSnapshot("abc123");
    copyToClipboardMock.mockResolvedValue(true);
    resolveControlUiRepoRootMock.mockReturnValue("/repo");
    mockDevServerExit(0);

    await dashboardCommand(runtime, { mode: "dev", noOpen: true });

    expect(copyToClipboardMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18790/?gatewayUrl=ws%3A%2F%2F127.0.0.1%3A18789&token=abc123",
    );
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ["/repo/scripts/ui.js", "dev", "--port", "18790"],
      {
        cwd: "/repo",
        env: process.env,
        stdio: "inherit",
      },
    );
    expect(runtime.log).toHaveBeenCalledWith("Using existing gateway at ws://127.0.0.1:18789.");
    expect(runtime.log).toHaveBeenCalledWith(
      "Starting Control UI dev server (Vite HMR) on port 18790...",
    );
  });

  it("uses explicit uiPort for `dashboard dev`", async () => {
    mockSnapshot("abc123");
    copyToClipboardMock.mockResolvedValue(true);
    resolveControlUiRepoRootMock.mockReturnValue("/repo");
    mockDevServerExit(0);

    await dashboardCommand(runtime, { mode: "dev", noOpen: true, uiPort: "18888" });

    expect(copyToClipboardMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18888/?gatewayUrl=ws%3A%2F%2F127.0.0.1%3A18789&token=abc123",
    );
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ["/repo/scripts/ui.js", "dev", "--port", "18888"],
      {
        cwd: "/repo",
        env: process.env,
        stdio: "inherit",
      },
    );
  });

  it("auto-starts local gateway when probe fails and loopback port is free", async () => {
    mockSnapshot("abc123");
    copyToClipboardMock.mockResolvedValue(true);
    resolveControlUiRepoRootMock.mockReturnValue("/repo");
    probeGatewayReachableMock.mockResolvedValue({
      ok: false,
      detail: "gateway closed (1006): no close reason",
    });

    const gatewayChild = createMockChild();
    const uiChild = createMockChild();
    setTimeout(() => {
      uiChild.exitCode = 0;
      uiChild.emit("exit", 0);
    }, 0);
    spawnMock.mockReturnValueOnce(gatewayChild as never).mockReturnValueOnce(uiChild as never);

    await dashboardCommand(runtime, { mode: "dev", noOpen: true });

    expect(tryListenOnPortMock).toHaveBeenCalledWith({ port: 18789 });
    const gatewayArgs = spawnMock.mock.calls[0]?.[1] as string[];
    expect(gatewayArgs.slice(1)).toEqual([
      "gateway",
      "run",
      "--bind",
      "loopback",
      "--port",
      "18789",
      "--force",
    ]);
    expect(waitForGatewayReachableMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "ws://127.0.0.1:18789",
        token: "abc123",
        deadlineMs: 18_000,
      }),
    );
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      process.execPath,
      ["/repo/scripts/ui.js", "dev", "--port", "18790"],
      {
        cwd: "/repo",
        env: process.env,
        stdio: "inherit",
      },
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Using local gateway started by dashboard dev at ws://127.0.0.1:18789.",
    );
    expect(gatewayChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("fails fast when gateway probe fails and loopback port is occupied", async () => {
    mockSnapshot("abc123");
    copyToClipboardMock.mockResolvedValue(true);
    resolveControlUiRepoRootMock.mockReturnValue("/repo");
    probeGatewayReachableMock.mockResolvedValue({
      ok: false,
      detail: "gateway closed (1008): connect failed",
    });
    tryListenOnPortMock.mockRejectedValue(new Error("EADDRINUSE"));

    await expect(dashboardCommand(runtime, { mode: "dev", noOpen: true })).rejects.toThrow(
      "Port 18789 is already in use",
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("throws when `dashboard dev` is run outside a source checkout", async () => {
    mockSnapshot("abc123");
    copyToClipboardMock.mockResolvedValue(true);
    resolveControlUiRepoRootMock.mockReturnValue(null);
    existsSyncMock.mockReturnValue(false);

    await expect(dashboardCommand(runtime, { mode: "dev", noOpen: true })).rejects.toThrow(
      "requires a source checkout",
    );
  });

  it("throws when uiPort is invalid", async () => {
    mockSnapshot("abc123");
    copyToClipboardMock.mockResolvedValue(true);

    await expect(
      dashboardCommand(runtime, { mode: "dev", noOpen: true, uiPort: "not-a-port" }),
    ).rejects.toThrow("Invalid dashboard dev port");
  });
});
