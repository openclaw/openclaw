import { EventEmitter } from "node:events";
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createVitestProcessCompletion,
  forwardSignalToVitestProcessGroup,
  installVitestProcessGroupCleanup,
  parseVitestProcessGroupMembers,
  resolveVitestProcessGroupSignalTarget,
  shouldUseDetachedVitestProcessGroup,
} from "../../scripts/vitest-process-group.mts";

describe("vitest process group helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function procStat(pid: number, state: string, ppid: number, pgid: number, comm = "node") {
    return `${pid} (${comm}) ${state} ${ppid} ${pgid} 0`;
  }
  const procError = (code: string) => Object.assign(new Error(code), { code });
  function procRead<T>(value: T | Error): T {
    if (value instanceof Error) {
      throw value;
    }
    return value;
  }
  const procScans = () =>
    vi.mocked(fs.readdirSync).mock.calls.filter(([path]) => String(path) === "/proc");
  async function rejectAtDeadline(completion: Promise<unknown>, message: string) {
    const rejected = expect(completion).rejects.toThrow(message);
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
  }

  function mockLinuxProc(
    pids: string[],
    stats: Record<string, string | NodeJS.ErrnoException>,
    listError?: NodeJS.ErrnoException,
    mounts: string | NodeJS.ErrnoException = "proc /proc proc rw 0 0\n",
    taskLists: Record<string, (string[] | NodeJS.ErrnoException)[]> = {},
  ) {
    const taskReads = new Map<string, number>();
    vi.spyOn(fs, "readdirSync").mockImplementation((path) => {
      if (String(path) === "/proc") {
        return procRead(listError ?? pids) as never;
      }
      const pid = /^\/proc\/(\d+)\/task$/.exec(String(path))?.[1] ?? "";
      const lists = taskLists[pid] ?? [[pid]];
      const index = taskReads.get(pid) ?? 0;
      taskReads.set(pid, index + 1);
      return procRead(lists[Math.min(index, lists.length - 1)]) as never;
    });
    vi.spyOn(fs, "readFileSync").mockImplementation((file) => {
      if (String(file) === "/proc/self/mounts") {
        return procRead<string>(mounts);
      }
      const task = /^\/proc\/(\d+)\/task\/(\d+)\/stat$/.exec(String(file));
      const pid = /^\/proc\/(\d+)\/stat$/.exec(String(file))?.[1] ?? "";
      const taskStat = task ? stats[`${task[1]}/${task[2]}`] : undefined;
      const stat = procRead(taskStat ?? stats[task && task[1] === task[2] ? task[1]! : pid]);
      if (typeof stat !== "string") {
        throw new Error(`missing mocked stat for ${pid}`);
      }
      return stat;
    });
  }

  function startLinuxCompletion(
    pid = 4200,
    kill: (pid: number, signal?: NodeJS.Signals | 0) => boolean = vi.fn(() => true),
  ) {
    const child = Object.assign(new EventEmitter(), { pid });
    const completion = createVitestProcessCompletion({
      child: child as never,
      detached: true,
      platform: "linux",
      kill,
    });
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    return completion;
  }

  function cleanupFixture(
    forceSignal?: Parameters<typeof installVitestProcessGroupCleanup>[0]["forceSignal"],
    capacity = false,
  ) {
    const fakeProcess = new EventEmitter().setMaxListeners(10);
    const setMaxListeners = vi.spyOn(fakeProcess, "setMaxListeners");
    const processObject = capacity
      ? fakeProcess
      : {
          on: fakeProcess.on.bind(fakeProcess),
          off: fakeProcess.off.bind(fakeProcess),
        };
    const kill = vi.fn();
    const install = (pid = 4200) =>
      installVitestProcessGroupCleanup({
        child: { pid },
        forceSignal,
        processObject: processObject as unknown as NodeJS.Process,
        platform: "darwin",
        kill,
      });
    return {
      install,
      kill,
      fakeProcess,
      setMaxListeners,
      emit: (event: string) => fakeProcess.emit(event),
      expectCounts(this: void, count: number) {
        expect(
          ["SIGINT", "SIGTERM", "exit"].map((event) => fakeProcess.listenerCount(event)),
        ).toEqual([count, count, count]);
      },
    };
  }

  it("uses detached process groups on non-Windows hosts", () => {
    expect(shouldUseDetachedVitestProcessGroup("darwin")).toBe(true);
    expect(shouldUseDetachedVitestProcessGroup("linux")).toBe(true);
    expect(shouldUseDetachedVitestProcessGroup("win32")).toBe(false);
  });

  it.each([
    [4200, "darwin", -4200],
    [4200, "win32", 4200],
    [undefined, "darwin", null],
  ] as const)("targets pid %s on %s", (childPid, platform, target) => {
    expect(resolveVitestProcessGroupSignalTarget({ childPid, platform })).toBe(target);
  });

  it("formats bounded process-group diagnostics without command arguments", () => {
    expect(
      parseVitestProcessGroupMembers(
        [
          " 116 1 116 Z node",
          " 117 1 116 Sl ci.internal.example:8443",
          " 118 1 116 S SECRET_TOKEN",
          " 119 1 999 S unrelated",
        ].join("\n"),
        116,
      ),
    ).toBe(
      "pid=116 ppid=1 state=Z comm=node; pid=117 ppid=1 state=Sl comm=other; pid=118 ppid=1 state=S comm=other",
    );
  });

  const missingTask = procError("ENOENT");
  const taskCases: [
    string,
    (string[] | NodeJS.ErrnoException)[],
    string | NodeJS.ErrnoException | undefined,
    string | undefined,
  ][] = [
    ["runnable worker", [["4200", "4201"]], procStat(4201, "S", 1, 4200), "tid=4201"],
    ["mismatched TID", [["4200", "4201"]], procStat(4202, "Z", 1, 4200), "unavailable"],
    ["inaccessible task dir", [procError("EACCES")], undefined, "unavailable"],
    ["missing task dir with leader", [missingTask], undefined, "unavailable"],
    ["disappeared TID", [["4200", "4201"], ["4200"]], missingTask, undefined],
    ["still-present TID", [["4200", "4201"]], missingTask, "unavailable"],
    ["new TID", [["4200"], ["4200", "4201"]], missingTask, "unavailable"],
  ];

  it.each(taskCases)("handles a %s fail-closed", async (_label, taskLists, workerStat, failure) => {
    if (failure) {
      vi.useFakeTimers();
    }
    mockLinuxProc(
      ["4200"],
      {
        "4200": procStat(4200, "Z", 1, 4200),
        "4200/4200": procStat(4200, "Z", 1, 4200),
        ...(workerStat ? { "4200/4201": workerStat } : {}),
      },
      undefined,
      undefined,
      { "4200": taskLists },
    );
    const completion = startLinuxCompletion();
    if (!failure) {
      await expect(completion).resolves.toEqual({ code: 0, signal: null });
      return;
    }
    await rejectAtDeadline(completion, failure);
  });

  it("fails closed before PID scans for a missing proc mount", async () => {
    vi.useFakeTimers();
    mockLinuxProc(
      ["4200"],
      { "4200": procStat(4200, "Z", 1, 4200) },
      undefined,
      "tmpfs /tmp tmpfs rw 0 0\n",
    );
    await rejectAtDeadline(startLinuxCompletion(), "members: unavailable");
    expect(fs.readdirSync).not.toHaveBeenCalled();
  });

  it("accepts a Linux process group gone during deadline inspection", async () => {
    vi.useFakeTimers();
    mockLinuxProc([], {});
    const missing = procError("ESRCH");
    const kill = vi.fn((_target: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0 && procScans().length >= 2) {
        throw missing;
      }
      return true;
    });

    const completion = startLinuxCompletion(4200, kill);
    const settled = expect(completion).resolves.toEqual({ code: 0, signal: null });

    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
    expect(procScans()).toHaveLength(2);
  });

  it("skips ENOENT races and accepts PID/PGID 1 with PPID 0", async () => {
    mockLinuxProc(["2", "1"], {
      "1": procStat(1, "Z", 0, 1, "init"),
      "2": missingTask,
    });
    await expect(startLinuxCompletion(1)).resolves.toEqual({ code: 0, signal: null });
  });

  it.each([
    ["a mismatched stat PID", ["4200"], { "4200": procStat(4201, "Z", 1, 4200) }, undefined],
    ["a non-ENOENT read failure", ["4200"], { "4200": procError("EACCES") }, undefined],
    ["unavailable proc", [], {}, procError("EACCES")],
  ])("fails closed for %s", async (_label, pids, stats, listError) => {
    vi.useFakeTimers();
    mockLinuxProc(pids, stats, listError);
    await rejectAtDeadline(startLinuxCompletion(), "process group 4200 remained alive 1000ms");
  });

  it("sorts and bounds classified Linux process-group diagnostics", async () => {
    vi.useFakeTimers();
    const pids = Array.from({ length: 22 }, (_, index) => String(4200 + index)).toReversed();
    const comm = "ci.internal.example:8443";
    mockLinuxProc(
      pids,
      Object.fromEntries(pids.map((pid) => [pid, procStat(Number(pid), "S", 1, 4200, comm)])),
    );
    const rejected = startLinuxCompletion().catch((failure: unknown) => failure);
    await vi.advanceTimersByTimeAsync(1_000);
    const message = ((await rejected) as Error).message;
    expect(message.indexOf("pid=4200")).toBeLessThan(message.indexOf("pid=4201"));
    expect(message).toContain("pid=4219");
    expect(message).toContain("comm=other");
    expect(message).not.toMatch(/pid=4220|internal\.example|\n/);
  });

  it("forwards signals to the computed target and ignores cleanup races", () => {
    const kill = vi.fn();
    const forward = () =>
      forwardSignalToVitestProcessGroup({
        child: { pid: 4200 },
        signal: "SIGTERM",
        platform: "darwin",
        kill,
      });
    expect(forward()).toBe(true);
    expect(kill).toHaveBeenCalledWith(-4200, "SIGTERM");

    for (const code of ["ESRCH", "EPERM"]) {
      kill.mockImplementationOnce(() => {
        throw procError(code);
      });
      expect(forward()).toBe(false);
    }
  });

  it.each([
    ["Windows", { detached: true, platform: "win32" as const }],
    ["non-detached POSIX", { detached: false, platform: "darwin" as const }],
  ])("joins %s child exit and pipes without claiming a group join", async (_label, params) => {
    const child = Object.assign(new EventEmitter(), { pid: 4200 });
    const kill = vi.fn(() => true as const);
    const completion = createVitestProcessCompletion({
      child: child as never,
      kill,
      ...params,
    });

    child.emit("exit", 0, null);
    let completed = false;
    void completion.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    child.emit("close", 0, null);
    await expect(completion).resolves.toEqual({ code: 0, signal: null });
    expect(kill).not.toHaveBeenCalled();
  });

  it("retains the first parent signal while installing and removing cleanup listeners", () => {
    const { install, kill, emit, expectCounts } = cleanupFixture();
    const cleanup = install();
    expectCounts(1);
    expect(cleanup.getForwardedSignal()).toBeUndefined();

    emit("exit");
    expect(kill).toHaveBeenNthCalledWith(1, -4200, "SIGTERM");
    expect(cleanup.getForwardedSignal()).toBeUndefined();
    emit("SIGTERM");
    emit("SIGINT");
    expect(kill).toHaveBeenNthCalledWith(2, -4200, "SIGTERM");
    expect(kill).toHaveBeenNthCalledWith(3, -4200, "SIGINT");
    expect(cleanup.getForwardedSignal()).toBe("SIGTERM");

    cleanup.teardown();
    expectCounts(0);
    expect(cleanup.getForwardedSignal()).toBe("SIGTERM");
  });

  it("can force-kill process groups after forwarded parent signals", async () => {
    const { install, kill, emit } = cleanupFixture("SIGKILL");
    const cleanup = install();
    emit("SIGTERM");
    await Promise.resolve();

    expect(kill).toHaveBeenNthCalledWith(1, -4200, "SIGTERM");
    expect(kill).toHaveBeenNthCalledWith(2, -4200, "SIGKILL");

    cleanup.teardown();
  });

  it("raises process listener limits for highly parallel cleanup handlers", () => {
    const { install, fakeProcess, setMaxListeners, expectCounts } = cleanupFixture(undefined, true);
    const cleanups = Array.from({ length: 12 }, (_, index) => install(4200 + index));
    expect(fakeProcess.getMaxListeners()).toBeGreaterThan(10);
    expect(setMaxListeners).toHaveBeenCalled();

    for (const cleanup of cleanups) {
      cleanup.teardown();
    }
    expectCounts(0);
  });
});
