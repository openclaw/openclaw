import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const resolveLsofCommandSyncMock = vi.hoisted(() => vi.fn());
const resolveGatewayPortMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

vi.mock("./ports-lsof.js", () => ({
  resolveLsofCommandSync: (...args: unknown[]) => resolveLsofCommandSyncMock(...args),
}));

vi.mock("../config/paths.js", () => ({
  resolveGatewayPort: (...args: unknown[]) => resolveGatewayPortMock(...args),
}));

let __testing: typeof import("./restart-stale-pids.js").__testing;
let cleanStaleGatewayProcessesSync: typeof import("./restart-stale-pids.js").cleanStaleGatewayProcessesSync;
let findGatewayPidsOnPortSync: typeof import("./restart-stale-pids.js").findGatewayPidsOnPortSync;

beforeEach(async () => {
  vi.resetModules();
  ({ __testing, cleanStaleGatewayProcessesSync, findGatewayPidsOnPortSync } =
    await import("./restart-stale-pids.js"));
  spawnSyncMock.mockReset();
  resolveLsofCommandSyncMock.mockReset();
  resolveGatewayPortMock.mockReset();

  resolveLsofCommandSyncMock.mockReturnValue("/usr/sbin/lsof");
  resolveGatewayPortMock.mockReturnValue(18789);
  __testing.setSleepSyncOverride(() => {});
});

afterEach(() => {
  __testing.setSleepSyncOverride(null);
  vi.restoreAllMocks();
});

describe.runIf(process.platform !== "win32")("findGatewayPidsOnPortSync", () => {
  it("parses lsof output and filters non-openclaw/current processes", () => {
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stdout: [
        `p${process.pid}`,
        "copenclaw",
        "p4100",
        "copenclaw-gateway",
        "p4200",
        "cnode",
        "p4300",
        "cOpenClaw",
      ].join("\n"),
    });

    const pids = findGatewayPidsOnPortSync(18789);

    expect(pids).toEqual([4100, 4300]);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "/usr/sbin/lsof",
      ["-nP", "-iTCP:18789", "-sTCP:LISTEN", "-Fpc"],
      expect.objectContaining({ encoding: "utf8", timeout: 2000 }),
    );
  });

  it("returns empty when lsof fails", () => {
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 1,
      stdout: "",
      stderr: "lsof failed",
    });

    expect(findGatewayPidsOnPortSync(18789)).toEqual([]);
  });
});

describe.runIf(process.platform !== "win32")("cleanStaleGatewayProcessesSync", () => {
  it("kills stale gateway pids discovered on the gateway port", () => {
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stdout: ["p6001", "copenclaw", "p6002", "copenclaw-gateway"].join("\n"),
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const killed = cleanStaleGatewayProcessesSync();

    expect(killed).toEqual([6001, 6002]);
    expect(resolveGatewayPortMock).toHaveBeenCalledWith(undefined, process.env);
    expect(killSpy).toHaveBeenCalledWith(6001, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(6002, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(6001, "SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(6002, "SIGKILL");
  });

  it("uses explicit port override when provided", () => {
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stdout: ["p7001", "copenclaw"].join("\n"),
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const killed = cleanStaleGatewayProcessesSync(19999);

    expect(killed).toEqual([7001]);
    expect(resolveGatewayPortMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "/usr/sbin/lsof",
      ["-nP", "-iTCP:19999", "-sTCP:LISTEN", "-Fpc"],
      expect.objectContaining({ encoding: "utf8", timeout: 2000 }),
    );
    expect(killSpy).toHaveBeenCalledWith(7001, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(7001, "SIGKILL");
  });

  it("returns empty when no stale listeners are found", () => {
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stdout: "",
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const killed = cleanStaleGatewayProcessesSync();

    expect(killed).toEqual([]);
    expect(killSpy).not.toHaveBeenCalled();
  });
});
