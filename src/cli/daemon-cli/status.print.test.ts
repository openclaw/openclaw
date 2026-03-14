import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  log: vi.fn<(line: string) => void>(),
  error: vi.fn<(line: string) => void>(),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: runtime,
}));

vi.mock("../../terminal/theme.js", () => ({
  colorize: (_rich: boolean, _theme: unknown, text: string) => text,
}));

vi.mock("../../commands/onboard-helpers.js", () => ({
  resolveControlUiLinks: () => ({ httpUrl: "http://127.0.0.1:18789" }),
}));

vi.mock("../../daemon/inspect.js", () => ({
  renderGatewayServiceCleanupHints: () => [],
}));

vi.mock("../../daemon/launchd.js", () => ({
  resolveGatewayLogPaths: () => ({
    stdoutPath: "/tmp/gateway.out.log",
    stderrPath: "/tmp/gateway.err.log",
  }),
}));

vi.mock("../../daemon/systemd-hints.js", () => ({
  isSystemdUnavailableDetail: () => false,
  renderSystemdUnavailableHints: () => [],
}));

vi.mock("../../infra/wsl.js", () => ({
  isWSLEnv: () => false,
}));

vi.mock("../../logging.js", () => ({
  getResolvedLoggerSettings: () => ({ file: "/tmp/openclaw.log" }),
}));

vi.mock("./shared.js", () => ({
  createCliStatusTextStyles: () => ({
    rich: false,
    label: (text: string) => text,
    accent: (text: string) => text,
    infoText: (text: string) => text,
    okText: (text: string) => text,
    warnText: (text: string) => text,
    errorText: (text: string) => text,
  }),
  filterDaemonEnv: () => ({}),
  formatRuntimeStatus: () => "running (pid 8000)",
  resolveRuntimeStatusColor: () => "",
  renderRuntimeHints: () => [],
  safeDaemonEnv: () => [],
}));

vi.mock("./status.gather.js", () => ({
  renderPortDiagnosticsForCli: () => [],
  resolvePortListeningAddresses: () => ["127.0.0.1:18789"],
}));

const { printDaemonStatus } = await import("./status.print.js");

describe("printDaemonStatus", () => {
  beforeEach(() => {
    runtime.log.mockReset();
    runtime.error.mockReset();
  });

  it("prints stale gateway pid guidance when runtime does not own the listener", () => {
    printDaemonStatus(
      {
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: { status: "running", pid: 8000 },
        },
        gateway: {
          bindMode: "loopback",
          bindHost: "127.0.0.1",
          port: 18789,
          portSource: "env/config",
          probeUrl: "ws://127.0.0.1:18789",
        },
        port: {
          port: 18789,
          status: "busy",
          listeners: [{ pid: 9000, ppid: 8999, address: "127.0.0.1:18789" }],
          hints: [],
        },
        rpc: {
          ok: false,
          error: "gateway closed (1006 abnormal closure (no close frame))",
          url: "ws://127.0.0.1:18789",
        },
        health: {
          healthy: false,
          staleGatewayPids: [9000],
        },
        extraServices: [],
      },
      { json: false },
    );

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Gateway runtime PID does not own the listening port"),
    );
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("openclaw gateway restart"));
  });
});
