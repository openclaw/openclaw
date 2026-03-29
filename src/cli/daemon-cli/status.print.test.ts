import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatCliCommand } from "../command-format.js";

const runtime = vi.hoisted(() => ({
  log: vi.fn<(line: string) => void>(),
  error: vi.fn<(line: string) => void>(),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: runtime,
}));

vi.mock("../../terminal/theme.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../terminal/theme.js")>();
  return {
    ...actual,
    colorize: (_rich: boolean, _theme: unknown, text: string) => text,
  };
});

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
  resolveDaemonContainerContext: () => null,
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
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining(formatCliCommand("openclaw gateway restart")),
    );
  });

  it("prints Windows log and repair details when present", () => {
    printDaemonStatus(
      {
        service: {
          label: "Scheduled Task",
          loaded: true,
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: { status: "running", pid: 8000 },
        },
        logs: {
          directory: "C:\\Users\\user\\.openclaw\\logs\\gateway",
          stdoutPath: "C:\\Users\\user\\.openclaw\\logs\\gateway\\gateway.out.log",
          stderrPath: "C:\\Users\\user\\.openclaw\\logs\\gateway\\gateway.err.log",
        },
        windows: {
          serviceMode: "startup-fallback",
          taskName: "OpenClaw Gateway",
          taskRegistered: false,
          startupEntryInstalled: true,
          taskScriptPath: "C:\\Users\\user\\.openclaw\\gateway\\OpenClaw Gateway.cmd",
          registrationPath:
            "C:\\Users\\user\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\OpenClaw Gateway.cmd",
          registrationDetail:
            "Startup-folder login item is installed at C:\\Users\\user\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\OpenClaw Gateway.cmd.",
          logDir: "C:\\Users\\user\\.openclaw\\logs\\gateway",
          stdoutPath: "C:\\Users\\user\\.openclaw\\logs\\gateway\\gateway.out.log",
          stderrPath: "C:\\Users\\user\\.openclaw\\logs\\gateway\\gateway.err.log",
          degradedReason: "Windows is using the Startup-folder fallback instead of a Scheduled Task.",
          recommendedAction:
            "Re-run from an elevated PowerShell session if you want Scheduled Task supervision.",
          wsl: {
            wslExeAvailable: true,
            defaultDistroName: "Ubuntu-24.04",
            defaultDistroReachable: true,
            systemdEnabled: false,
            recommendedAction:
              "Enable systemd in `/etc/wsl.conf`, run `wsl --shutdown`, then reopen your distro.",
          },
        },
        extraServices: [],
      },
      { json: false },
    );

    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("Gateway logs:"));
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("Windows mode:"));
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("WSL2:"));
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Windows issue:"));
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Windows fix:"));
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("WSL2 fix:"));
  });
});
