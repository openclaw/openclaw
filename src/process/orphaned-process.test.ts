import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
const mocks = vi.hoisted(() => ({
  ps: vi.fn(),
  identity: vi.fn(),
  dead: vi.fn(),
  command: vi.fn(),
  realpath: vi.fn(),
}));
vi.mock("node:child_process", () => ({ execFileSync: mocks.ps }));
vi.mock("node:fs", () => ({ realpathSync: mocks.realpath }));
// mock-isolation: synthetic process identities must never inspect the test host's PIDs.
vi.mock("../shared/pid-alive.js", () => ({
  getProcessInstanceStartTime: mocks.identity,
  isPidDefinitelyDead: mocks.dead,
}));
// mock-isolation: native process inspection is represented by the synthetic kernel below.
vi.mock("./supervisor/darwin-process-command.js", () => ({
  readDarwinProcessCommand: mocks.command,
}));
import { reapOrphanedProcesses } from "./orphaned-process.js";

const command = "/state/llama-server";
const rootArgs = [command, "--port", "19321"];
const defaults = { parentPid: 1, uid: 501, command, executable: command, cwd: "/state" };
type KernelProcess = typeof defaults & { pid: number; argv: string[]; startedAt: number | null };
const processes = new Map<number, KernelProcess>();
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const uidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
let killSpy: MockInstance<typeof process.kill>;
let onPs: ((pid?: number) => void) | undefined;
let onSignal: (...args: Parameters<typeof process.kill>) => void;

function add(pid: number, overrides: Partial<KernelProcess> = {}) {
  const entry = { ...defaults, pid, argv: [...rootArgs], startedAt: pid, ...overrides };
  processes.set(pid, entry);
  return entry;
}
function exit(pid: number) {
  processes.delete(pid);
  for (const entry of processes.values()) {
    if (entry.parentPid === pid) {
      entry.parentPid = 1;
    }
  }
}
function reap(
  options: { cwd?: string; signal?: AbortSignal; onReap?: (pid: number) => void } = {},
) {
  return reapOrphanedProcesses({
    command,
    matchesArguments: (argv) =>
      argv.length === rootArgs.length && argv.every((value, index) => value === rootArgs[index]),
    ...options,
  });
}
async function expectUntouched(options: Parameters<typeof reap>[0] = {}) {
  expect(await reap(options)).toEqual([]);
  expect(killSpy).not.toHaveBeenCalled();
  expect(processes.has(100)).toBe(true);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  processes.clear();
  onPs = undefined;
  onSignal = exit;
  Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
  Object.defineProperty(process, "getuid", { configurable: true, value: () => 501 });
  mocks.realpath.mockImplementation((directory: string) => directory);
  mocks.ps.mockImplementation((executable: string, args: string[]) => {
    if (executable === "/usr/sbin/lsof") {
      const pid = Number(args[args.indexOf("-p") + 1]);
      return `p${pid}\0\nfcwd\0n${processes.get(pid)?.cwd}\0\n`;
    }
    const pid = args[0] === "-p" ? Number(args[1]) : undefined;
    onPs?.(pid);
    const rows = pid === undefined ? [...processes.values()] : [processes.get(pid)];
    if (pid !== undefined && !rows[0]) {
      throw Object.assign(new Error("No such process"), { status: 1 });
    }
    return rows
      .flatMap((row) => (row ? [`${row.pid} ${row.parentPid} ${row.uid} ${row.command}`] : []))
      .join("\n");
  });
  mocks.identity.mockImplementation((pid: number) =>
    pid === process.pid ? 1 : (processes.get(pid)?.startedAt ?? null),
  );
  mocks.dead.mockImplementation((pid: number) => !processes.has(pid));
  mocks.command.mockImplementation((pid: number) => {
    const row = processes.get(pid);
    return row && { executable: row.executable, argv: [...row.argv] };
  });
  killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    onSignal(pid, signal);
    return true;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (platformDescriptor) {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
  if (uidDescriptor) {
    Object.defineProperty(process, "getuid", uidDescriptor);
  } else {
    Reflect.deleteProperty(process, "getuid");
  }
});

it("reaps only the captured managed macOS tree", async () => {
  add(100);
  add(101, { parentPid: 100, argv: [command, "--model", "/models/embedding.gguf"] });
  add(102, { parentPid: 101, argv: [command, "--worker"] });
  add(103, { parentPid: 100, executable: "/other/llama-server" });
  add(104, { parentPid: 103 });
  expect(await reap()).toEqual([100]);
  expect(killSpy.mock.calls).toEqual([100, 101, 102].map((pid) => [pid, "SIGTERM"]));
  expect([...processes.keys()]).toEqual([103, 104]);
});

it.each<[string, Partial<KernelProcess>]>([
  ["live parent", { parentPid: 50 }],
  ["foreign user", { uid: 502 }],
  ["foreign executable with spoofed argv", { executable: "/other/llama-server" }],
  ["different argv zero", { argv: ["llama-server", ...rootArgs.slice(1)] }],
  ["different port", { argv: [...rootArgs.slice(0, -1), "19322"] }],
  ["different working directory", { cwd: "/other" }],
])("leaves %s untouched", async (_name, change) => {
  add(100, change);
  mocks.realpath.mockReturnValue("/state");
  await expectUntouched({ cwd: "/state-alias" });
});
it.each<[string, () => unknown]>([
  ["unknown host birth", () => mocks.identity.mockReturnValueOnce(null)],
  ["Linux PID 1", () => Object.defineProperty(process, "platform", { value: "linux" })],
])("leaves %s untouched", async (_name, prepare) => {
  add(100);
  prepare();
  await expectUntouched();
  expect(mocks.ps).not.toHaveBeenCalled();
});
it("leaves an unreadable foreign installation untouched", async () => {
  add(100, { command: "/other/llama-server" });
  mocks.command.mockImplementation(() => {
    throw new Error("unreadable");
  });
  await expectUntouched();
  expect(mocks.command).not.toHaveBeenCalled();
});
it.each<[string, Partial<KernelProcess>, string?]>([
  ["unverifiable birth", { startedAt: null }, "Cannot verify orphaned process 100"],
  ["reparented root", { parentPid: 50 }, "changed identity"],
  ["recycled root", { startedAt: 999 }],
  ["vanished root", {}],
])("never signals a %s tree", async (name, change, error) => {
  const root = add(100);
  add(101, { parentPid: 100 });
  if (name === "unverifiable birth") {
    Object.assign(root, change);
  }
  if (name === "vanished root") {
    onPs = (pid) => pid === 100 && exit(pid);
  }
  const result = reap({ onReap: () => Object.assign(root, change) });
  if (error) {
    await expect(result).rejects.toThrow(error);
  } else {
    expect(await result).toEqual([]);
  }
  expect(killSpy).not.toHaveBeenCalled();
});

it("finishes captured children after root exit without signaling a reused PID or new descendant", async () => {
  add(100);
  const child = add(101, { parentPid: 100 });
  add(102, { parentPid: 101 });
  onSignal = (pid, signal) => {
    if (pid === 100) {
      exit(pid);
      add(103, { parentPid: 101 });
    }
    if (pid === 101 && signal === "SIGTERM") {
      child.startedAt = 999;
    }
    if (signal === "SIGKILL") {
      exit(pid);
    }
  };
  const result = reap();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await result).toEqual([100]);
  expect(killSpy).toHaveBeenCalledWith(102, "SIGKILL");
  expect(killSpy).not.toHaveBeenCalledWith(101, "SIGKILL");
  expect(killSpy).not.toHaveBeenCalledWith(103, expect.anything());
  expect([...processes.keys()]).toEqual([101, 103]);
});

it.each(["before TERM", "after TERM"])("joins cleanup on cancellation %s", async (when) => {
  add(100);
  add(101, { parentPid: 100 });
  add(200);
  const controller = new AbortController();
  const cancelled = new Error("caller cancelled");
  onSignal = (pid, signal) => (signal === "SIGTERM" ? controller.abort(cancelled) : exit(pid));
  const result = reap({
    signal: controller.signal,
    onReap: when === "before TERM" ? () => controller.abort(cancelled) : undefined,
  });
  const rejected = expect(result).rejects.toBe(cancelled);
  await vi.advanceTimersByTimeAsync(5_000);
  await rejected;
  if (when === "after TERM") {
    expect(killSpy).toHaveBeenCalledWith(100, "SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(101, "SIGKILL");
  } else {
    expect(killSpy).not.toHaveBeenCalled();
  }
  expect(processes.has(200)).toBe(true);
});

it.each<[string, Partial<KernelProcess>]>([
  ["arguments", { argv: [command, "--other"] }],
  ["executable", { executable: "/other/llama-server" }],
  ["user", { uid: 502 }],
  ["working directory", { cwd: "/other" }],
])("refuses changed %s before escalation", async (...[, change]) => {
  const root = add(100);
  onSignal = () => Object.assign(root, change);
  const result = reap({ cwd: "/state" });
  const rejected = expect(result).rejects.toThrow(
    "Could not safely stop orphaned process tree 100",
  );
  await vi.advanceTimersByTimeAsync(10_000);
  await rejected;
  expect(killSpy).toHaveBeenCalledExactlyOnceWith(100, "SIGTERM");
});
