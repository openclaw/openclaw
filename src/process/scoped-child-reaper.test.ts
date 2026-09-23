import { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleAdoptedChildZombieReapAfterExit } from "./scoped-child-reaper.js";

const proc = vi.hoisted(() => ({
  entries: vi.fn<() => string[]>(),
  stat: vi.fn<(path: string) => string>(),
  wait: vi.fn<(pid: number, status: null, options: number) => number>(),
}));

vi.mock("node:fs", () => ({ readdirSync: proc.entries, readFileSync: proc.stat }));
vi.mock("node:module", () => ({
  createRequire: () => () => ({ load: () => ({ func: () => proc.wait }) }),
}));

const ROOT = 400;
const originalPlatform = process.platform;

function trackedRoot(exited = false): ChildProcess {
  const child = new ChildProcess();
  Object.defineProperties(child, {
    pid: { value: ROOT },
    exitCode: { value: exited ? 0 : null },
    signalCode: { value: null },
  });
  return child;
}

function setProcesses(rows: Array<{ pid: number; ppid: number; pgid: number; state: string }>) {
  const stats = new Map(
    rows.map((row) => [
      `/proc/${row.pid}/stat`,
      `${row.pid} (fixture (child)) ${row.state} ${row.ppid} ${row.pgid} 0 0 0`,
    ]),
  );
  proc.entries.mockImplementation(() => rows.map((row) => String(row.pid)));
  proc.stat.mockImplementation((path) => {
    const stat = stats.get(path);
    if (stat === undefined) {
      throw new Error("process no longer exists");
    }
    return stat;
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  Object.defineProperty(process, "platform", { value: "linux" });
  proc.wait.mockImplementation((pid) => pid);
  setProcesses([]);
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, "platform", { value: originalPlatform });
});

describe("adopted process-group cleanup", () => {
  it("waits for tracked-root exit and leaves tracked, live, and unrelated children intact", () => {
    const child = trackedRoot();
    setProcesses([
      { pid: ROOT, ppid: process.pid, pgid: ROOT, state: "Z" },
      { pid: 401, ppid: process.pid, pgid: ROOT, state: "Z" },
      { pid: 402, ppid: process.pid, pgid: ROOT, state: "S" },
      { pid: 403, ppid: process.pid, pgid: 700, state: "Z" },
      { pid: 404, ppid: 900, pgid: ROOT, state: "Z" },
    ]);
    scheduleAdoptedChildZombieReapAfterExit(child, true);
    vi.advanceTimersByTime(100);
    expect(proc.wait).not.toHaveBeenCalled();
    expect(proc.entries).not.toHaveBeenCalled();

    child.emit("exit", null, "SIGTERM");
    expect(proc.wait).not.toHaveBeenCalled();
    vi.advanceTimersByTime(25);
    expect(proc.wait.mock.calls).toEqual([[401, null, 1]]);
  });

  it("retains cleanup until a live intermediate releases its zombie", () => {
    const child = trackedRoot(true);
    setProcesses([
      { pid: 401, ppid: process.pid, pgid: ROOT, state: "S" },
      { pid: 402, ppid: 401, pgid: ROOT, state: "Z" },
    ]);
    scheduleAdoptedChildZombieReapAfterExit(child, true);
    vi.advanceTimersByTime(500);
    expect(proc.wait).not.toHaveBeenCalled();

    setProcesses([
      { pid: 401, ppid: process.pid, pgid: ROOT, state: "Z" },
      { pid: 402, ppid: process.pid, pgid: ROOT, state: "Z" },
    ]);
    vi.advanceTimersByTime(25);
    expect(proc.wait.mock.calls).toEqual([
      [401, null, 1],
      [402, null, 1],
    ]);
    setProcesses([]);
    vi.advanceTimersByTime(50);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a pending child for another paced scan", () => {
    setProcesses([{ pid: 401, ppid: process.pid, pgid: ROOT, state: "Z" }]);
    proc.wait.mockReturnValueOnce(0);
    scheduleAdoptedChildZombieReapAfterExit(trackedRoot(true), true);
    vi.advanceTimersByTime(25);
    expect(proc.wait).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(24);
    expect(proc.wait).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(proc.wait).toHaveBeenCalledTimes(2);
  });

  it("stops after two quiet scans even if unrelated children remain", () => {
    setProcesses([{ pid: 401, ppid: process.pid, pgid: 700, state: "Z" }]);
    scheduleAdoptedChildZombieReapAfterExit(trackedRoot(true), true);
    vi.advanceTimersByTime(50);
    expect(proc.wait).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const scans = proc.entries.mock.calls.length;
    vi.advanceTimersByTime(30_000);
    expect(proc.entries).toHaveBeenCalledTimes(scans);
  });

  it("stops at its deadline while an owned process is still alive", () => {
    setProcesses([{ pid: 401, ppid: process.pid, pgid: ROOT, state: "S" }]);
    scheduleAdoptedChildZombieReapAfterExit(trackedRoot(true), true);
    vi.advanceTimersByTime(30_000);
    expect(proc.wait).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const scans = proc.entries.mock.calls.length;
    vi.advanceTimersByTime(30_000);
    expect(proc.entries).toHaveBeenCalledTimes(scans);
  });

  it("registers one cleanup when termination escalates from TERM to KILL", () => {
    const child = trackedRoot();
    scheduleAdoptedChildZombieReapAfterExit(child, true);
    scheduleAdoptedChildZombieReapAfterExit(child, true);
    expect(child.listenerCount("exit")).toBe(1);
    child.emit("exit", null, "SIGKILL");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(50);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["darwin", "win32"])("does no work on %s", (platform) => {
    Object.defineProperty(process, "platform", { value: platform });
    const child = trackedRoot(true);
    scheduleAdoptedChildZombieReapAfterExit(child, true);
    expect(vi.getTimerCount()).toBe(0);
    expect(proc.entries).not.toHaveBeenCalled();
    expect(proc.wait).not.toHaveBeenCalled();
  });

  it("does not claim a child that fell back to a shared process group", () => {
    const child = trackedRoot();
    scheduleAdoptedChildZombieReapAfterExit(child, false);
    child.emit("exit", null, "SIGTERM");
    expect(vi.getTimerCount()).toBe(0);
    expect(proc.entries).not.toHaveBeenCalled();
    expect(proc.wait).not.toHaveBeenCalled();
  });
});
