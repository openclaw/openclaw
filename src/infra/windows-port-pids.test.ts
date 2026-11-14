import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync }));

// mock-isolation: route spawns by executable basename; host install roots differ per runner.
vi.mock("./windows-install-roots.js", () => ({
  getWindowsPowerShellExePath: () => "powershell.exe",
  getWindowsSystem32ExePath: (name: string) => `C:\\Windows\\System32\\${name}`,
  getWindowsWmicExePath: () => "wmic.exe",
}));

const { readWindowsListeningPidsResultSync } = await import("./windows-port-pids.js");

type SpawnResult = { status?: number | null; stdout?: string; error?: NodeJS.ErrnoException };

function routeSpawn(params: { powershell: SpawnResult; netstat: SpawnResult }) {
  spawnSync.mockImplementation((file: string) =>
    file.endsWith("netstat.exe") ? params.netstat : params.powershell,
  );
}

function netstatRow(port: number, pid: number): string {
  return [
    "Active Connections",
    "",
    "  Proto  Local Address          Foreign Address        State           PID",
    `  TCP    0.0.0.0:${port}          0.0.0.0:0              LISTENING       ${pid}`,
    "",
  ].join("\r\n");
}

describe("windows listening pid census", () => {
  beforeEach(() => {
    spawnSync.mockReset();
  });

  it("consults netstat when the PowerShell census succeeds but reports no listener", () => {
    routeSpawn({
      powershell: { status: 0, stdout: "" },
      netstat: { status: 0, stdout: netstatRow(18_789, 4_242) },
    });

    expect(readWindowsListeningPidsResultSync(18_789)).toEqual({ ok: true, pids: [4_242] });
  });

  it("keeps the PowerShell answer without a second query when it reports a listener", () => {
    routeSpawn({
      powershell: { status: 0, stdout: "4242\r\n" },
      netstat: { status: 0, stdout: netstatRow(18_789, 9_999) },
    });

    expect(readWindowsListeningPidsResultSync(18_789)).toEqual({ ok: true, pids: [4_242] });
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it("still falls back to netstat when the PowerShell query fails", () => {
    routeSpawn({
      powershell: { status: 1, stdout: "" },
      netstat: { status: 0, stdout: netstatRow(18_789, 4_242) },
    });

    expect(readWindowsListeningPidsResultSync(18_789)).toEqual({ ok: true, pids: [4_242] });
  });

  it("reports a free port only when neither collector sees a listener", () => {
    routeSpawn({
      powershell: { status: 0, stdout: "\r\n" },
      netstat: { status: 0, stdout: netstatRow(18_790, 4_242) },
    });

    expect(readWindowsListeningPidsResultSync(18_789)).toEqual({ ok: true, pids: [] });
  });

  it("keeps an empty PowerShell census usable when the netstat fallback fails", () => {
    routeSpawn({
      powershell: { status: 0, stdout: "" },
      netstat: { error: Object.assign(new Error("spawn netstat.exe ENOENT"), { code: "ENOENT" }) },
    });

    expect(readWindowsListeningPidsResultSync(18_789)).toEqual({ ok: true, pids: [] });
  });
});
