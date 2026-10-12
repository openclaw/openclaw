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

const command = "/state/llama-cpp/build/llama-server";
const rootArgs = [command, "--models-preset", "/state/llama-cpp/models.ini", "--port", "19321"];
type KernelProcess = {
  pid: number;
  parentPid: number;
  uid: number;
  command: string;
  executable: string;
  argv: string[];
  startedAt: number | null;
  cwd: string;
};
const processes = new Map<number, KernelProcess>();
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const uidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
let killSpy: MockInstance<typeof process.kill>;
let onPs: ((pid?: number) => void) | undefined;
let onSignal: ((...args: Parameters<typeof process.kill>) => void) | undefined;

function add(pid: number, overrides: Partial<KernelProcess> = {}) {
  const entry: KernelProcess = {
    pid,
    parentPid: 1,
    uid: 501,
    command,
    executable: command,
    argv: [...rootArgs],
    startedAt: pid * 100,
    cwd: "/state",
    ...overrides,
  };
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  processes.clear();
  onPs = undefined;
  onSignal = undefined;
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
    if (onSignal) {
      onSignal(pid, signal);
    } else {
      exit(pid);
    }
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
  expect(killSpy).toHaveBeenCalledTimes(3);
  expect(killSpy).toHaveBeenCalledWith(100, "SIGTERM");
  expect(killSpy).toHaveBeenCalledWith(101, "SIGTERM");
  expect(killSpy).toHaveBeenCalledWith(102, "SIGTERM");
  expect([...processes.keys()]).toEqual([103, 104]);
});

it.each([
  { name: "live parent", change: { parentPid: 50 } },
  { name: "foreign user", change: { uid: 502 } },
  { name: "foreign executable with spoofed argv", change: { executable: "/other/llama-server" } },
  { name: "different argv zero", change: { argv: ["llama-server", ...rootArgs.slice(1)] } },
  { name: "different preset", change: { argv: [command, "--models-preset", "/other/models.ini"] } },
  { name: "different port", change: { argv: [...rootArgs.slice(0, -1), "19322"] } },
  { name: "unrelated uninspectable birth", change: { argv: [command], startedAt: null } },
])("leaves $name untouched", async ({ change }) => {
  add(100, change);
  expect(await reap()).toEqual([]);
  expect(killSpy).not.toHaveBeenCalled();
  expect(processes.has(100)).toBe(true);
});

it("reports unavailable precise identity only for a matching process", async () => {
  add(100, { startedAt: null });
  await expect(reap()).rejects.toThrow("Cannot verify orphaned process 100");
  expect(killSpy).not.toHaveBeenCalled();
});

it("leaves hosts without native birth identity support unchanged", async () => {
  add(100);
  mocks.identity.mockImplementation((pid: number) =>
    pid === process.pid ? null : (processes.get(pid)?.startedAt ?? null),
  );
  expect(await reap()).toEqual([]);
  expect(mocks.ps).not.toHaveBeenCalled();
  expect(killSpy).not.toHaveBeenCalled();
});

it.each([
  { cwd: "/state", expected: [100] },
  { cwd: "/other", expected: [] },
])("requires the configured working directory, observed $cwd", async ({ cwd, expected }) => {
  add(100, { cwd });
  mocks.realpath.mockReturnValue("/state");
  expect(await reap({ cwd: "/state-alias" })).toEqual(expected);
  expect(killSpy).toHaveBeenCalledTimes(expected.length);
});

it("does not inspect an unreadable server from another installation", async () => {
  add(100, { command: "/other/llama-server" });
  mocks.command.mockImplementation(() => {
    throw new Error("foreign process arguments are unavailable");
  });
  expect(await reap()).toEqual([]);
  expect(mocks.command).not.toHaveBeenCalled();
  expect(killSpy).not.toHaveBeenCalled();
});

it("refuses a root that acquires a live parent before signaling its tree", async () => {
  const root = add(100);
  add(101, { parentPid: 100 });
  await expect(
    reap({
      onReap: () => {
        root.parentPid = 50;
      },
    }),
  ).rejects.toThrow("changed identity");
  expect(killSpy).not.toHaveBeenCalled();
});

it("treats disappearance during the final process inspection as already stopped", async () => {
  add(100);
  onPs = (pid) => {
    if (pid === 100) {
      exit(pid);
    }
  };
  expect(await reap()).toEqual([]);
  expect(killSpy).not.toHaveBeenCalled();
});

it("does not signal any captured process when the root PID is recycled before TERM", async () => {
  const root = add(100);
  add(101, { parentPid: 100 });
  expect(
    await reap({
      onReap: () => {
        root.startedAt = 999;
      },
    }),
  ).toEqual([]);
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

it.each(["before inspection", "before TERM", "after TERM"])(
  "honors cancellation %s without abandoning captured cleanup",
  async (when) => {
    add(100);
    add(101, { parentPid: 100 });
    add(200);
    const controller = new AbortController();
    const cancelled = new Error("caller cancelled");
    if (when === "before inspection") {
      controller.abort(cancelled);
    }
    onSignal = (pid, signal) => {
      if (signal === "SIGTERM") {
        controller.abort(cancelled);
      } else {
        exit(pid);
      }
    };
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
  },
);

it.each(["arguments", "executable", "user", "working directory"])(
  "refuses changed %s before escalation",
  async (change) => {
    const root = add(100);
    onSignal = () => {
      if (change === "arguments") {
        root.argv = [command, "--other"];
      } else if (change === "executable") {
        root.executable = "/other/llama-server";
      } else if (change === "user") {
        root.uid = 502;
      } else {
        root.cwd = "/other";
      }
    };
    const result = reap({ cwd: "/state" });
    const rejected = expect(result).rejects.toThrow(
      "Could not safely stop orphaned process tree 100",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(killSpy).toHaveBeenCalledExactlyOnceWith(100, "SIGTERM");
  },
);

it("reports a surviving process after both bounded stop attempts", async () => {
  add(100);
  onSignal = () => {};
  const rejected = expect(reap()).rejects.toThrow(
    "Could not safely stop orphaned process tree 100",
  );
  await vi.advanceTimersByTimeAsync(10_000);
  await rejected;
  expect(killSpy).toHaveBeenCalledTimes(2);
  expect(killSpy).toHaveBeenCalledWith(100, "SIGTERM");
  expect(killSpy).toHaveBeenCalledWith(100, "SIGKILL");
});

it.each(["linux", "win32"])("does not infer orphanhood from PID 1 on %s", async (platform) => {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  add(100);
  expect(await reap()).toEqual([]);
  expect(mocks.ps).not.toHaveBeenCalled();
  expect(killSpy).not.toHaveBeenCalled();
});
