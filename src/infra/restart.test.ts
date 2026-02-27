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

import {
  __testing,
  cleanStaleGatewayProcessesSync,
  findGatewayPidsOnPortSync,
} from "./restart-stale-pids.js";

beforeEach(() => {
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
