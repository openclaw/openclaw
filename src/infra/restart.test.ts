import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const resolveLsofCommandSyncMock = vi.hoisted(() => vi.fn());
const resolveGatewayPortMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("../../test/helpers/node-builtin-mocks.js");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
    },
  );
});

vi.mock("./ports-lsof.js", () => ({
  resolveLsofCommandSync: (...args: unknown[]) => resolveLsofCommandSyncMock(...args),
}));

vi.mock("../config/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../config/paths.js")>("../config/paths.js");
  return {
    ...actual,
    resolveGatewayPort: (...args: unknown[]) => resolveGatewayPortMock(...args),
  };
});

let __testing: typeof import("./restart-stale-pids.js").__testing;
let cleanStaleGatewayProcessesSync: typeof import("./restart-stale-pids.js").cleanStaleGatewayProcessesSync;
let findGatewayPidsOnPortSync: typeof import("./restart-stale-pids.js").findGatewayPidsOnPortSync;

let currentTimeMs = 0;

beforeAll(async () => {
  ({ __testing, cleanStaleGatewayProcessesSync, findGatewayPidsOnPortSync } =
    await import("./restart-stale-pids.js"));
});

beforeEach(() => {
  spawnSyncMock.mockReset();
  resolveLsofCommandSyncMock.mockReset();
  resolveGatewayPortMock.mockReset();

  currentTimeMs = 0;
  resolveLsofCommandSyncMock.mockReturnValue("/usr/sbin/lsof");
  resolveGatewayPortMock.mockReturnValue(18790);
  __testing.setSleepSyncOverride((ms) => {
    currentTimeMs += ms;
  });
  __testing.setDateNowOverride(() => currentTimeMs);
});

afterEach(() => {
  __testing.setSleepSyncOverride(null);
  __testing.setDateNowOverride(null);
  vi.restoreAllMocks();
});

describe.runIf(process.platform !== "win32")("findGatewayPidsOnPortSync", () => {
  it("parses lsof output and filters non-mullusi/current processes", () => {
    const gatewayPidA = process.pid + 1000;
    const gatewayPidB = process.pid + 2000;
    const foreignPid = process.pid + 3000;
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stdout: [
        `p${process.pid}`,
        "cmullusi",
        `p${gatewayPidA}`,
        "cmullusi-gateway",
        `p${foreignPid}`,
        "cnode",
        `p${gatewayPidB}`,
        "cMullusi",
      ].join("\n"),
    });

    const pids = findGatewayPidsOnPortSync(18790);

    expect(pids).toEqual([gatewayPidA, gatewayPidB]);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "/usr/sbin/lsof",
      ["-nP", "-iTCP:18790", "-sTCP:LISTEN", "-Fpc"],
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

    expect(findGatewayPidsOnPortSync(18790)).toEqual([]);
  });
});

describe.runIf(process.platform !== "win32")("cleanStaleGatewayProcessesSync", () => {
  it("kills stale gateway pids discovered on the gateway port", () => {
    const stalePidA = process.pid + 1000;
    const stalePidB = process.pid + 2000;
    spawnSyncMock
      .mockReturnValueOnce({
        error: undefined,
        status: 0,
        stdout: [`p${stalePidA}`, "cmullusi", `p${stalePidB}`, "cmullusi-gateway"].join("\n"),
      })
      .mockReturnValue({
        error: undefined,
        status: 1,
        stdout: "",
      });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const killed = cleanStaleGatewayProcessesSync();

    expect(killed).toEqual([stalePidA, stalePidB]);
    expect(resolveGatewayPortMock).toHaveBeenCalledWith(undefined, process.env);
    expect(killSpy).toHaveBeenCalledWith(stalePidA, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(stalePidB, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(stalePidA, "SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(stalePidB, "SIGKILL");
  });

  it("uses explicit port override when provided", () => {
    const stalePid = process.pid + 1000;
    spawnSyncMock
      .mockReturnValueOnce({
        error: undefined,
        status: 0,
        stdout: [`p${stalePid}`, "cmullusi"].join("\n"),
      })
      .mockReturnValue({
        error: undefined,
        status: 1,
        stdout: "",
      });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const killed = cleanStaleGatewayProcessesSync(19999);

    expect(killed).toEqual([stalePid]);
    expect(resolveGatewayPortMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "/usr/sbin/lsof",
      ["-nP", "-iTCP:19999", "-sTCP:LISTEN", "-Fpc"],
      expect.objectContaining({ encoding: "utf8", timeout: 2000 }),
    );
    expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGKILL");
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
