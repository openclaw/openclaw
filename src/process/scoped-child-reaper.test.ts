import { ChildProcess } from "node:child_process";
import type { ChildExit, ChildWaitState } from "@openclaw/proc-safe/reaper";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  readdirSync: proc.entries,
  readFileSync: proc.stat,
}));
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
const SELF = process.pid;
const originalPlatform = process.platform;

function trackedRoot(exited = false, pid = ROOT): ChildProcess {
  return Object.assign(new ChildProcess(), { pid, exitCode: exited ? 0 : null });
}

type ProcessRow = { pid: number; ppid: number; pgid: number; state: string };
const processRow = (pid = 401, state = "Z", ppid = SELF, pgid = ROOT) => ({
  pid,
  state,
  ppid,
  pgid,
});
let processRows: ProcessRow[] = [];
let initialSigchldListeners: ReturnType<typeof process.listeners>;
const unrelatedSigchldListener = () => {};

function addedSigchldListeners(listeners = process.listeners("SIGCHLD")) {
  return listeners.filter((listener) => !initialSigchldListeners.includes(listener));
}

function setProcesses(rows: ProcessRow[]) {
  processRows = rows;
  const children = rows.flatMap(({ pid, ppid }) => (ppid === SELF ? [pid] : [])).join(" ");
  proc.entries.mockImplementation((path?: string) =>
    path === "/proc/self/task" ? [String(process.pid), "900"] : rows.map((row) => String(row.pid)),
  );
  proc.stat.mockImplementation((path) => {
    if (path.endsWith("/children")) {
      return path === "/proc/self/task/900/children" ? children : "";
    }
    const row = rows.find(({ pid }) => path === `/proc/${pid}/stat`);
    if (!row) {
      throw new Error("process no longer exists");
    }
    return `${row.pid} (fixture (child)) ${row.state} ${row.ppid} ${row.pgid} 0 0 0`;
  });
}

async function reapAfter(delay = 25) {
  scheduleAdoptedChildZombieReapAfterExit(trackedRoot(true), true);
  await vi.advanceTimersByTimeAsync(delay);
}

function expectNoNativeReaping() {
  for (const mock of [proc.supported, proc.inspect, proc.wait]) {
    expect(mock).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  process.on("SIGCHLD", unrelatedSigchldListener);
  initialSigchldListeners = process.listeners("SIGCHLD");
  vi.useFakeTimers();
  vi.clearAllMocks();
  Object.defineProperty(process, "platform", { value: "linux" });
  proc.supported.mockReturnValue(true);
  proc.alive.mockImplementation(() => processRows.some((row) => row.pgid === ROOT));
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
  setProcesses([processRow()]);
});

afterEach(async () => {
  setProcesses([]);
  await vi.advanceTimersByTimeAsync(60_000);
  const listeners = process.listeners("SIGCHLD");
  process.off("SIGCHLD", unrelatedSigchldListener);
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(process, "platform", { value: originalPlatform });
  expect(addedSigchldListeners(listeners)).toEqual([]);
  expect(listeners).toContain(unrelatedSigchldListener);
});

it("bounds discovery for 50 retained groups and coalesces exit notifications", async () => {
  // An earlier file's reaper can finish after the next module generation starts.
  const onExit = () => {};
  process.on("SIGCHLD", onExit);
  initialSigchldListeners = process.listeners("SIGCHLD");
  setTimeout(() => process.off("SIGCHLD", onExit), 1_010);
  setProcesses(
    Array.from({ length: 50 }, (_, index) =>
      processRow(1_001 + index * 2, "S", process.pid, 1_000 + index * 2),
    ),
  );
  for (const row of processRows) {
    scheduleAdoptedChildZombieReapAfterExit(trackedRoot(true, row.pgid), true);
  }
  await vi.advanceTimersByTimeAsync(1_000);
  expect(proc.stat.mock.calls.length).toBeLessThanOrEqual(60);
  expect(addedSigchldListeners()).toHaveLength(1);

  setProcesses(processRows.map((row) => Object.assign(row, { state: "Z" })));
  for (let notice = 0; notice < 5; notice++) {
    process.emit("SIGCHLD");
    await vi.advanceTimersByTimeAsync(10);
  }
  expect(proc.wait).toHaveBeenCalledTimes(50);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(vi.getTimerCount()).toBe(0);
  expect(addedSigchldListeners()).toEqual([]);
  expect(process.listeners("SIGCHLD")).not.toContain(onExit);
});

it("retains groups across a failed enumeration until adoption is visible", async () => {
  setProcesses([processRow(401, "Z", 900)]);
  proc.entries.mockImplementationOnce(() => {
    throw new Error("proc unavailable");
  });
  await reapAfter(2_000);
  expect(proc.wait).not.toHaveBeenCalled();
  setProcesses([processRow()]);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(proc.wait.mock.calls).toEqual([[401]]);
});

it("retains an exit wakeup while child discovery is still in flight", async () => {
  setProcesses([processRow(401, "Z", 900)]);
  const discovery = Promise.withResolvers<string>();
  proc.entries.mockReturnValue(["900"]);
  proc.stat.mockReturnValueOnce(discovery.promise);
  await reapAfter();

  process.emit("SIGCHLD");
  await vi.advanceTimersByTimeAsync(25);
  setProcesses([processRow()]);
  discovery.resolve("");
  await vi.advanceTimersByTimeAsync(25);
  expect(proc.wait.mock.calls).toEqual([[401]]);
});

it("stops cleanup when an adopted zombie needs unavailable native support", async () => {
  proc.supported.mockReturnValue(false);
  await reapAfter();
  expect(proc.inspect).not.toHaveBeenCalled();
  expect(proc.wait).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

const nativeFailure = () => {
  throw new Error("native cleanup failed");
};
it.each([
  ["support failure", () => proc.supported.mockImplementationOnce(nativeFailure), 0],
  ["inspection failure", () => proc.inspect.mockImplementationOnce(nativeFailure), 0],
  ["wait failure", () => proc.wait.mockImplementationOnce(nativeFailure), 1],
  ["fresh native exit", () => proc.inspect.mockReturnValueOnce({ kind: "running" }), 0],
  ["pending wait", () => proc.wait.mockReturnValueOnce(null), 1],
] as const)("waits for %s before a paced retry", async (_, block, attempts) => {
  block();
  await reapAfter();
  expect(proc.wait).toHaveBeenCalledTimes(attempts);
  await vi.advanceTimersByTimeAsync(999);
  expect(proc.wait).toHaveBeenCalledTimes(attempts);
  await vi.advanceTimersByTimeAsync(1);
  expect(proc.wait).toHaveBeenCalledTimes(attempts + 1);
  expect(processRows).toEqual([]);
  await vi.advanceTimersByTimeAsync(1_050);
  expect(vi.getTimerCount()).toBe(0);
});
it("settles a cooperative descendant throughout a longer command grace period", async () => {
  setProcesses([processRow(401, "S")]);
  const termination = createCommandTerminationController({
    child: trackedRoot(true),
    cancelController: new AbortController(),
    processTree: { mode: "graceful" },
    killGraceMs: 45_000,
    isChildExited: () => true,
    isCommandSettled: () => false,
  });
  termination.terminate();
  await vi.advanceTimersByTimeAsync(31_000);
  setProcesses([processRow()]);
  await vi.advanceTimersByTimeAsync(15_000);
  await expect(termination.settle()).resolves.toBe("cooperative");
  expect(proc.wait.mock.calls).toEqual([[401]]);
});

it("retains cleanup until a live intermediate releases its zombie", async () => {
  setProcesses([processRow(401, "S"), processRow(402, "Z", 401)]);
  await reapAfter(500);
  expectNoNativeReaping();

  setProcesses([processRow(), processRow(402)]);
  process.emit("SIGCHLD");
  await vi.advanceTimersByTimeAsync(25);
  expect(proc.wait.mock.calls).toEqual([[401], [402]]);
  setProcesses([]);
  await vi.advanceTimersByTimeAsync(1_050);
  expect(vi.getTimerCount()).toBe(0);
});

it("stops at its deadline while an owned process is still alive", async () => {
  setProcesses([processRow(401, "S")]);
  await reapAfter(31_000);
  expect(proc.wait).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  const scans = proc.entries.mock.calls.length;
  await vi.advanceTimersByTimeAsync(31_000);
  expect(proc.entries).toHaveBeenCalledTimes(scans);
});

it.each([true, false])(
  "deduplicates cleanup only for an owned process group: %s",
  async (owned) => {
    setProcesses([]);
    const child = trackedRoot();
    scheduleAdoptedChildZombieReapAfterExit(child, owned);
    scheduleAdoptedChildZombieReapAfterExit(child, owned);
    expect(child.listenerCount("exit")).toBe(Number(owned));
    child.emit("exit", null, owned ? "SIGKILL" : "SIGTERM");
    expect(vi.getTimerCount()).toBe(Number(owned));
    await vi.advanceTimersByTimeAsync(1_050);
    expect(vi.getTimerCount()).toBe(0);
    expect(proc.entries).not.toHaveBeenCalled();
    expect(proc.wait).not.toHaveBeenCalled();
  },
);
