import { beforeEach, expect, it, vi } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";

const { readProcessAncestry, spawnSync } = vi.hoisted(() => ({
  readProcessAncestry: vi.fn<typeof import("@openclaw/proc-safe/identity").readProcessAncestry>(),
  spawnSync: vi.fn(),
}));
// mock-isolation: native ancestry would otherwise read the test host's real process tree.
vi.mock("@openclaw/proc-safe/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/proc-safe/identity")>()),
  readProcessAncestry,
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync,
}));
import { inspectSelfAndAncestorPidsSync } from "./restart-stale-pids.js";

const loginPid = process.pid + 2201;
const terminalPid = process.pid + 2202;
const shellStart = Date.parse("2026-11-03T12:00:01.500Z") * 1000;

function identity(pid: number, parentPid: number, startTimeMicros = shellStart) {
  return { pid, parentPid, startTimeMicros, startTimeResolutionMicros: 1, exited: false };
}

beforeEach(() => {
  // Terminal.app shells descend from root-owned /usr/bin/login, whose identity Darwin denies.
  readProcessAncestry.mockReset().mockImplementation((pid) =>
    pid === process.pid
      ? { chain: [identity(pid, loginPid)], complete: false, stoppedBy: "unreadable-parent" }
      : {
          chain: [identity(terminalPid, 1, shellStart - 9e6)],
          complete: true,
          stoppedBy: "root",
        },
  );
  spawnSync.mockReset();
});

it("keeps an unreadable parent unverified outside Darwin", () => {
  withMockedPlatform("linux", () => {
    const observed = inspectSelfAndAncestorPidsSync();
    expect(observed.complete).toBe(false);
    expect(observed.pids.has(loginPid)).toBe(true);
    expect(inspectSelfAndAncestorPidsSync(undefined, { requireVerifiedParent: true })).toEqual({
      pids: new Set([process.pid]),
      complete: false,
    });
  });
  expect(spawnSync).not.toHaveBeenCalled();
});

it.each([
  { name: "completes", loginStart: "Tue Nov  3 12:00:00 2026", complete: true },
  { name: "rejects a recycled", loginStart: "Tue Nov  3 12:00:02 2026", complete: false },
])("$name root-owned macOS login through the kernel process table", ({ loginStart, complete }) => {
  spawnSync.mockReturnValue({ status: 0, stdout: ` ${terminalPid} ${loginStart}\n` });
  withMockedPlatform("darwin", () => {
    expect(inspectSelfAndAncestorPidsSync(undefined, { requireVerifiedParent: true })).toEqual({
      pids: new Set(complete ? [process.pid, loginPid, terminalPid, 1] : [process.pid]),
      complete,
    });
  });
  expect(spawnSync).toHaveBeenCalledWith(
    "ps",
    ["-o", "ppid=,lstart=", "-p", String(loginPid)],
    expect.objectContaining({ env: expect.objectContaining({ LC_ALL: "C", TZ: "UTC" }) }),
  );
});
