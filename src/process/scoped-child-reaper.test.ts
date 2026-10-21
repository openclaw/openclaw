import { ChildProcess } from "node:child_process";
import type { ChildExit, ChildWaitState } from "@openclaw/proc-safe/reaper";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCommandTerminationController } from "./exec-termination.js";
import { scheduleAdoptedChildZombieReapAfterExit } from "./scoped-child-reaper.js";

const proc = vi.hoisted(() => ({
  entries: vi.fn<() => string[]>(),
  stat: vi.fn<(path: string) => string | Promise<string>>(),
  supported: vi.fn<() => boolean>(),
  inspect: vi.fn<(pid: number) => ChildWaitState>(),
  wait: vi.fn<(pid: number) => ChildExit | null>(),
  alive: vi.fn<() => boolean>(),
}));

// Count synchronous filesystem work too, so restoring the old scan cannot evade the budget.
vi.mock("node:fs", () => ({ readdirSync: proc.entries, readFileSync: proc.stat }));
vi.mock("node:fs/promises", () => ({ readdir: proc.entries, readFile: proc.stat }));
vi.mock("@openclaw/proc-safe/reaper", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/proc-safe/reaper")>()),
  isSupported: proc.supported,
  inspectChildWaitState: proc.inspect,
  reapChild: proc.wait,
}));
vi.mock("../infra/windows-install-roots.js", () => ({
  getWindowsSystem32ExePath: () => {
    throw new Error("Linux cleanup must not launch taskkill");
  },
}));
vi.mock("../shared/pid-alive.js", () => ({ getFileLockProcessStartTime: () => null }));
vi.mock("./child-process-tree.js", () => ({ isChildProcessTreeAlive: proc.alive }));
vi.mock("./kill-tree.js", () => ({ killProcessTree: vi.fn() }));
vi.mock("./exec-spawn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./exec-spawn.js")>()),
  runOutsideCommandProcessScope: vi.fn(),
  spawnCommand: vi.fn(),
}));

const ROOT = 400;
const originalPlatform = process.platform;

function trackedRoot(exited = false, pid = ROOT): ChildProcess {
  const child = new ChildProcess();
  Object.defineProperties(child, {
    pid: { value: pid },
    exitCode: { value: exited ? 0 : null },
    signalCode: { value: null },
  });
  return child;
}

type ProcessRow = { pid: number; ppid: number; pgid: number; state: string };
let processRows: ProcessRow[] = [];
let initialSigchldListeners: ReturnType<typeof process.listeners>;

function setProcesses(rows: ProcessRow[]) {
  processRows = rows;
  const stats = new Map(
    rows.map((row) => [
      `/proc/${row.pid}/stat`,
      `${row.pid} (fixture (child)) ${row.state} ${row.ppid} ${row.pgid} 0 0 0`,
    ]),
  );
  proc.entries.mockImplementation((path?: string) =>
    path === "/proc/self/task" ? [String(process.pid), "900"] : rows.map((row) => String(row.pid)),
  );
  proc.stat.mockImplementation((path) => {
    if (path.endsWith("/children")) {
      return path === "/proc/self/task/900/children"
        ? rows
            .filter((row) => row.ppid === process.pid)
            .map((row) => row.pid)
            .join(" ")
        : "";
    }
    const stat = stats.get(path);
    if (stat === undefined) {
      throw new Error("process no longer exists");
    }
    return stat;
  });
}

beforeEach(() => {
  initialSigchldListeners = process.listeners("SIGCHLD");
  vi.useFakeTimers();
  vi.clearAllMocks();
  Object.defineProperty(process, "platform", { value: "linux" });
  proc.supported.mockReturnValue(true);
  proc.inspect.mockImplementation((pid) => ({ kind: "exited", pid }));
  proc.wait.mockImplementation((pid) => {
    setProcesses(processRows.filter((row) => row.pid !== pid));
    return { pid, exitCode: 0, signal: null, signalNumber: null };
  });
  vi.spyOn(process, "kill").mockImplementation((pid) => {
    if (!processRows.some((row) => row.pgid === -pid && row.pid !== -pid)) {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    }
    return true;
  });
  setProcesses([]);
});

afterEach(async () => {
  setProcesses([]);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(process.listeners("SIGCHLD")).toEqual(initialSigchldListeners);
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(process, "platform", { value: originalPlatform });
});

describe("adopted process-group cleanup", () => {
  it("bounds discovery for 50 retained groups and coalesces exit notifications", async () => {
    setProcesses(
      Array.from({ length: 50 }, (_, index) => ({
        pid: 1_001 + index * 2,
        ppid: process.pid,
        pgid: 1_000 + index * 2,
        state: "S",
      })),
    );
    for (const row of processRows) {
      scheduleAdoptedChildZombieReapAfterExit(trackedRoot(true, row.pgid), true);
    }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(proc.stat.mock.calls.length).toBeLessThanOrEqual(60);
    expect(process.listenerCount("SIGCHLD")).toBe(initialSigchldListeners.length + 1);

    for (const row of processRows) {
      row.state = "Z";
    }
    setProcesses(processRows);
    for (let notice = 0; notice < 5; notice++) {
      process.emit("SIGCHLD");
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(proc.wait).toHaveBeenCalledTimes(50);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(process.listeners("SIGCHLD")).toEqual(initialSigchldListeners);
  });

  it("retains groups across a failed enumeration until adoption is visible", async () => {
    setProcesses([{ pid: 401, ppid: 900, pgid: ROOT, state: "Z" }]);
    proc.entries.mockImplementationOnce(() => {
      throw new Error("proc unavailable");
    });
    scheduleAdoptedChildZombieReapAfterExit(trackedRoot(true), true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(proc.wait).not.toHaveBeenCalled();
    setProcesses([{ pid: 401, ppid: process.pid, pgid: ROOT, state: "Z" }]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(proc.wait.mock.calls).toEqual([[401]]);
  });

  it("retains an exit wakeup while child discovery is still in flight", async () => {
    setProcesses([{ pid: 401, ppid: 900, pgid: ROOT, state: "Z" }]);
    const discovery = Promise.withResolvers<string>();
    proc.entries.mockReturnValue(["900"]);
    proc.stat.mockReturnValueOnce(discovery.promise);
    scheduleAdoptedChildZombieReapAfterExit(trackedRoot(true), true);
    await vi.advanceTimersByTimeAsync(25);

    process.emit("SIGCHLD");
    await vi.advanceTimersByTimeAsync(25);
    setProcesses([{ pid: 401, ppid: process.pid, pgid: ROOT, state: "Z" }]);
    discovery.resolve("");
    await vi.advanceTimersByTimeAsync(25);
    expect(proc.wait.mock.calls).toEqual([[401]]);
  });

  it.each(["absent", "tracked-root", "unrelated"] as const)(
    "does not initialize native reaping for a group with only %s processes",
    async (scenario) => {
      setProcesses(
        scenario === "absent"
          ? []
          : scenario === "tracked-root"
            ? [{ pid: ROOT, ppid: process.pid, pgid: ROOT, state: "Z" }]
            : [
                { pid: 401, ppid: process.pid, pgid: 700, state: "Z" },
                { pid: 402, ppid: 900, pgid: ROOT, state: "Z" },
              ],
      );
      scheduleAdoptedChildZombieReapAfterExit(trackedRoot(true), true);
      await vi.advanceTimersByTimeAsync(1_050);
      expect(proc.supported).not.toHaveBeenCalled();
      expect(proc.inspect).not.toHaveBeenCalled();
      expect(proc.wait).not.toHaveBeenCalled();
      if (scenario !== "unrelated") {
        expect(vi.getTimerCount()).toBe(0);
      }
    },
  );

  it("stops cleanup when an adopted zombie needs unavailable native support", async () => {
    setProcesses([{ pid: 401, ppid: process.pid, pgid: ROOT, state: "Z" }]);
    proc.supported.mockReturnValue(false);
    scheduleAdoptedChildZombieReapAfterExit(trackedRoot(true), true);
    await vi.advanceTimersByTimeAsync(25);
    expect(proc.supported).toHaveBeenCalledTimes(1);
    expect(proc.inspect).not.toHaveBeenCalled();
    expect(proc.wait).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["supported", "inspect", "wait"] as const)(
    "retries a transient native %s failure within the existing cleanup budget",
    async (operation) => {
      setProcesses([{ pid: 401, ppid: process.pid, pgid: ROOT, state: "Z" }]);
      proc[operation].mockImplementationOnce(() => {
        throw new Error("native cleanup failed");
      });
      expect(() => scheduleAdoptedChildZombieReapAfterExit(trackedRoot(true), true)).not.toThrow();
      await vi.advanceTimersByTimeAsync(25);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(proc.wait).toHaveLastReturnedWith({
        pid: 401,
        exitCode: 0,
        signal: null,
        signalNumber: null,
      });
      setProcesses([]);
      await vi.advanceTimersByTimeAsync(1_050);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not reap until the fresh native observation confirms an exited child", async () => {
    setProcesses([{ pid: 401, ppid: process.pid, pgid: ROOT, state: "Z" }]);
    proc.inspect.mockReturnValueOnce({ kind: "running" });
    scheduleAdoptedChildZombieReapAfterExit(trackedRoot(true), true);
    await vi.advanceTimersByTimeAsync(25);
    expect(proc.wait).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(proc.wait.mock.calls).toEqual([[401]]);
  });
  it("settles a cooperative descendant throughout a longer command grace period", async () => {
    const child = trackedRoot(true);
    proc.alive.mockReturnValue(true);
    setProcesses([{ pid: 401, ppid: process.pid, pgid: ROOT, state: "S" }]);
    proc.wait.mockImplementation((pid) => {
      proc.alive.mockReturnValue(false);
      setProcesses([]);
      return { pid, exitCode: 0, signal: null, signalNumber: null };
    });
    const termination = createCommandTerminationController({
      child,
      cancelController: new AbortController(),
      processTree: { mode: "graceful" },
      killGraceMs: 45_000,
      isChildExited: () => true,
      isCommandSettled: () => false,
    });
    termination.terminate();
    await vi.advanceTimersByTimeAsync(31_000);
    setProcesses([{ pid: 401, ppid: process.pid, pgid: ROOT, state: "Z" }]);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(termination.settle()).resolves.toBe("cooperative");
    expect(proc.wait.mock.calls).toEqual([[401]]);
  });

  it("waits for tracked-root exit and leaves tracked, live, and unrelated children intact", async () => {
    const child = trackedRoot();
    setProcesses([
      { pid: ROOT, ppid: process.pid, pgid: ROOT, state: "Z" },
      { pid: 401, ppid: process.pid, pgid: ROOT, state: "Z" },
      { pid: 402, ppid: process.pid, pgid: ROOT, state: "S" },
      { pid: 403, ppid: process.pid, pgid: 700, state: "Z" },
      { pid: 404, ppid: 900, pgid: ROOT, state: "Z" },
    ]);
    scheduleAdoptedChildZombieReapAfterExit(child, true);
    await vi.advanceTimersByTimeAsync(100);
    expect(proc.wait).not.toHaveBeenCalled();
    expect(proc.inspect).not.toHaveBeenCalled();
    expect(proc.supported).not.toHaveBeenCalled();
    expect(proc.entries).not.toHaveBeenCalled();

    child.emit("exit", null, "SIGTERM");
    expect(proc.wait).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(25);
    expect(proc.supported).toHaveBeenCalledTimes(1);
    expect(proc.inspect.mock.calls).toEqual([[401]]);
    expect(proc.wait.mock.calls).toEqual([[401]]);
  });

  it("retains cleanup until a live intermediate releases its zombie", async () => {
    const child = trackedRoot(true);
    setProcesses([
      { pid: 401, ppid: process.pid, pgid: ROOT, state: "S" },
      { pid: 402, ppid: 401, pgid: ROOT, state: "Z" },
    ]);
    scheduleAdoptedChildZombieReapAfterExit(child, true);
    await vi.advanceTimersByTimeAsync(500);
    expect(proc.supported).not.toHaveBeenCalled();
    expect(proc.inspect).not.toHaveBeenCalled();
    expect(proc.wait).not.toHaveBeenCalled();

    setProcesses([
      { pid: 401, ppid: process.pid, pgid: ROOT, state: "Z" },
      { pid: 402, ppid: process.pid, pgid: ROOT, state: "Z" },
    ]);
    process.emit("SIGCHLD");
    await vi.advanceTimersByTimeAsync(25);
    expect(proc.wait.mock.calls).toEqual([[401], [402]]);
    setProcesses([]);
    await vi.advanceTimersByTimeAsync(1_050);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a pending child for another paced scan", async () => {
    setProcesses([{ pid: 401, ppid: process.pid, pgid: ROOT, state: "Z" }]);
    proc.wait.mockReturnValueOnce(null);
    scheduleAdoptedChildZombieReapAfterExit(trackedRoot(true), true);
    await vi.advanceTimersByTimeAsync(25);
    expect(proc.wait).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(proc.wait).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(proc.wait).toHaveBeenCalledTimes(2);
  });

  it("stops at its deadline while an owned process is still alive", async () => {
    setProcesses([{ pid: 401, ppid: process.pid, pgid: ROOT, state: "S" }]);
    scheduleAdoptedChildZombieReapAfterExit(trackedRoot(true), true);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(proc.wait).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const scans = proc.entries.mock.calls.length;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(proc.entries).toHaveBeenCalledTimes(scans);
  });

  it("registers one cleanup when termination escalates from TERM to KILL", async () => {
    const child = trackedRoot();
    scheduleAdoptedChildZombieReapAfterExit(child, true);
    scheduleAdoptedChildZombieReapAfterExit(child, true);
    expect(child.listenerCount("exit")).toBe(1);
    child.emit("exit", null, "SIGKILL");
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_050);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not claim a child that fell back to a shared process group", async () => {
    const child = trackedRoot();
    scheduleAdoptedChildZombieReapAfterExit(child, false);
    child.emit("exit", null, "SIGTERM");
    expect(vi.getTimerCount()).toBe(0);
    expect(proc.entries).not.toHaveBeenCalled();
    expect(proc.wait).not.toHaveBeenCalled();
  });
});
