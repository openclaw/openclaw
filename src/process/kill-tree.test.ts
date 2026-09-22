// Kill tree tests cover process tree termination and platform-specific fallbacks.
import { EventEmitter } from "node:events";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";

const { opendirSyncMock, readFileSyncMock, spawnMock, spawnSyncMock } = vi.hoisted(() => ({
  opendirSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

vi.mock("node:fs", () => ({
  opendirSync: (...args: unknown[]) => opendirSyncMock(...args),
  readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
}));

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      spawn: (...args: unknown[]) => spawnMock(...args),
      spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
    },
  );
});

let killProcessTree: typeof import("./kill-tree.js").killProcessTree;
let signalPtySessionTree: typeof import("./kill-tree.js").signalPtySessionTree;
let signalProcessTree: typeof import("./kill-tree.js").signalProcessTree;

function expectTaskkillCall(index: number, args: string[]) {
  expect(spawnMock.mock.calls[index]).toStrictEqual([
    "taskkill",
    args,
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  ]);
}

function mockIsProcessGroupLeader(...pids: number[]) {
  spawnSyncMock.mockImplementation((command: string, args: string[]) => {
    if (command === "ps" && args[0] === "-p" && args[2] === "-o" && args[3] === "pgid=") {
      const pid = Number.parseInt(args[1] ?? "", 10);
      if (pids.includes(pid)) {
        return { status: 0, stdout: String(pid) };
      }
    }
    return { status: 1, stdout: "" };
  });
}

type ProcFixture = {
  children?: number[];
  ppid?: number;
  starttime?: string | (() => string);
};

function createAttachedTreeFixture() {
  // The walker excludes its own PID. Fixture descendants must stay distinct
  // from the real test process, including when CI assigns a familiar PID.
  const rootPid = process.pid + 1;
  return { rootPid, childPid: rootPid + 1, grandchildPid: rootPid + 2, foreignPid: rootPid + 3 };
}

function mockProcTree(nodes: Record<number, ProcFixture>) {
  readFileSyncMock.mockImplementation((filePath: string) => {
    const match = filePath.match(/^\/proc\/(\d+)\/(stat|task\/\d+\/children)$/);
    const pid = Number(match?.[1]);
    const node = nodes[pid];
    if (!match || !node) {
      throw new Error("unexpected proc path");
    }
    if (match[2] !== "stat") {
      return (node.children ?? []).join(" ");
    }
    const starttime = typeof node.starttime === "function" ? node.starttime() : node.starttime;
    if (starttime === undefined) {
      throw new Error("process identity unavailable");
    }
    // proc(5) places ppid at field 4 and starttime at field 22, after comm.
    return `${pid} (fixture) S ${node.ppid ?? 1} ${pid} ${pid} 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 ${starttime} 0`;
  });
}

describe("killProcessTree", () => {
  let killSpy: MockInstance<typeof process.kill>;

  beforeAll(async () => {
    ({ killProcessTree, signalProcessTree, signalPtySessionTree } = await import("./kill-tree.js"));
  });

  beforeEach(() => {
    opendirSyncMock.mockReset();
    opendirSyncMock.mockImplementation((file: string) => {
      const pid = file.match(/^\/proc\/(\d+)\/task$/)?.[1];
      let returned = false;
      return {
        readSync: () => (returned ? null : ((returned = true), { name: pid })),
        closeSync: vi.fn(),
      };
    });
    readFileSyncMock.mockReset();
    readFileSyncMock.mockImplementation(() => {
      throw new Error("proc unavailable");
    });
    spawnMock.mockReset();
    spawnSyncMock.mockClear();
    killSpy = vi.spyOn(process, "kill");
    vi.useFakeTimers();
  });

  afterEach(() => {
    killSpy.mockRestore();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("on Windows skips delayed force-kill when PID is already gone", async () => {
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 4242 && signal === 0) {
        throw new Error("ESRCH");
      }
      return true;
    }) as typeof process.kill);

    await withMockedPlatform("win32", async () => {
      killProcessTree(4242, { graceMs: 25 });

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expectTaskkillCall(0, ["/T", "/PID", "4242"]);

      await vi.advanceTimersByTimeAsync(25);
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
  });

  it("on Windows force-kills after grace period only when PID still exists", async () => {
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 5252 && signal === 0) {
        return true;
      }
      return true;
    }) as typeof process.kill);

    await withMockedPlatform("win32", async () => {
      killProcessTree(5252, { graceMs: 10 });

      await vi.advanceTimersByTimeAsync(10);

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expectTaskkillCall(0, ["/T", "/PID", "5252"]);
      expectTaskkillCall(1, ["/F", "/T", "/PID", "5252"]);
    });
  });

  it("on Windows force-kills immediately when graceful taskkill refuses a live process tree", async () => {
    const gracefulTaskkill = new EventEmitter();
    spawnMock.mockReturnValueOnce(gracefulTaskkill);
    killSpy.mockImplementation(() => true);

    await withMockedPlatform("win32", async () => {
      killProcessTree(4711, { graceMs: 30_000 });

      expectTaskkillCall(0, ["/T", "/PID", "4711"]);
      gracefulTaskkill.emit("close", 128);

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expectTaskkillCall(1, ["/F", "/T", "/PID", "4711"]);
    });
  });

  it("on Windows does not force-kill a disappeared or reused PID after taskkill fails", async () => {
    const gracefulTaskkill = new EventEmitter();
    spawnMock.mockReturnValueOnce(gracefulTaskkill);
    let processWasReused = false;
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 4712 && signal === 0 && !processWasReused) {
        throw new Error("ESRCH");
      }
      return true;
    }) as typeof process.kill);

    await withMockedPlatform("win32", async () => {
      killProcessTree(4712, { graceMs: 25 });
      gracefulTaskkill.emit("close", 128);
      expect(spawnMock).toHaveBeenCalledTimes(1);

      processWasReused = true;
      await vi.advanceTimersByTimeAsync(25);

      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
  });

  it("on Windows force-kills only once when taskkill failure races the grace timer", async () => {
    const gracefulTaskkill = new EventEmitter();
    spawnMock.mockReturnValueOnce(gracefulTaskkill);
    killSpy.mockImplementation(() => true);

    await withMockedPlatform("win32", async () => {
      killProcessTree(4713, { graceMs: 20 });
      gracefulTaskkill.emit("close", 128);
      await vi.advanceTimersByTimeAsync(20);

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expectTaskkillCall(1, ["/F", "/T", "/PID", "4713"]);
    });
  });

  it("on Windows waits for the grace timer when graceful taskkill cannot start", async () => {
    const gracefulTaskkill = new EventEmitter();
    spawnMock.mockReturnValueOnce(gracefulTaskkill);
    killSpy.mockImplementation(() => true);

    await withMockedPlatform("win32", async () => {
      killProcessTree(4714, { graceMs: 15 });
      expect(() => gracefulTaskkill.emit("error", new Error("spawn ENOENT"))).not.toThrow();
      gracefulTaskkill.emit("close", -4058);
      expect(spawnMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(15);

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expectTaskkillCall(1, ["/F", "/T", "/PID", "4714"]);
    });
  });

  it("on Windows keeps an explicitly requested failed tree signal single-shot", async () => {
    const gracefulTaskkill = new EventEmitter();
    spawnMock.mockReturnValueOnce(gracefulTaskkill);

    await withMockedPlatform("win32", async () => {
      signalProcessTree(4715, "SIGTERM");
      gracefulTaskkill.emit("close", 128);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expectTaskkillCall(0, ["/T", "/PID", "4715"]);
    });
  });

  it("on Unix never probes a reused positive PID after its selected group disappears", async () => {
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -3333 && signal === 0) {
        throw new Error("ESRCH");
      }
      return true;
    }) as typeof process.kill);

    await withMockedPlatform("linux", async () => {
      mockIsProcessGroupLeader(3333);
      killProcessTree(3333, { graceMs: 10 });

      await vi.advanceTimersByTimeAsync(10);

      expect(killSpy).toHaveBeenCalledWith(-3333, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(-3333, "SIGKILL");
      expect(killSpy).not.toHaveBeenCalledWith(3333, "SIGKILL");
      expect(killSpy.mock.calls.every((call: unknown[]) => call[0] === -3333)).toBe(true);
    });
  });

  it.each([false, true])(
    "on Unix keeps grace escalation group-only (group vanishes: %s)",
    async (vanishes) => {
      killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === -4444 && signal === "SIGKILL" && vanishes) {
          throw new Error("ESRCH");
        }
        return true;
      }) as typeof process.kill);

      await withMockedPlatform("linux", async () => {
        mockIsProcessGroupLeader(4444);
        killProcessTree(4444, { graceMs: 5 });

        await vi.advanceTimersByTimeAsync(5);

        expect(killSpy).toHaveBeenCalledWith(-4444, "SIGTERM");
        expect(killSpy).toHaveBeenCalledWith(-4444, "SIGKILL");
        expect(killSpy.mock.calls.every((call: unknown[]) => call[0] === -4444)).toBe(true);
      });
    },
  );

  it.each([false, true])(
    "on Unix keeps immediate force-kill group-only (group missing: %s)",
    async (missing) => {
      killSpy.mockImplementation((pid: number) => {
        if (pid === -4949 && missing) {
          throw new Error("ESRCH");
        }
        return true;
      });

      await withMockedPlatform("linux", async () => {
        mockIsProcessGroupLeader(4949);
        killProcessTree(4949, { force: true });
        await vi.advanceTimersByTimeAsync(60_000);

        expect(killSpy).toHaveBeenCalledTimes(1);
        expect(killSpy).toHaveBeenCalledWith(-4949, "SIGKILL");
        expect(killSpy).not.toHaveBeenCalledWith(-4949, "SIGTERM");
      });
    },
  );

  it("on Unix force-kills a live detached group even after the parent pid exits", async () => {
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -4545 && signal === 0) {
        return true;
      }
      if (pid === 4545 && signal === 0) {
        throw new Error("ESRCH");
      }
      return true;
    }) as typeof process.kill);

    await withMockedPlatform("linux", async () => {
      killProcessTree(4545, { graceMs: 5, detached: true });

      await vi.advanceTimersByTimeAsync(5);

      expect(killSpy).toHaveBeenCalledWith(-4545, "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(-4545, "SIGKILL");
      expect(killSpy).not.toHaveBeenCalledWith(4545, "SIGKILL");
      expect(spawnSyncMock).not.toHaveBeenCalled();
    });
  });

  it.each([false, true])(
    "on Unix cleans attached descendants without signaling the parent's process group (self entry: %s)",
    async (includeSelf) => {
      const { rootPid, childPid, grandchildPid } = createAttachedTreeFixture();
      killSpy.mockImplementation(() => true);
      mockProcTree({
        [rootPid]: {
          starttime: "100",
          children: [childPid, ...(includeSelf ? [process.pid] : [])],
        },
        [childPid]: { starttime: "101", ppid: rootPid, children: [grandchildPid] },
        [grandchildPid]: { starttime: "102", ppid: childPid },
        [process.pid]: { starttime: "103", ppid: rootPid },
      });

      await withMockedPlatform("linux", async () => {
        killProcessTree(rootPid, { graceMs: 10, detached: false });
        await vi.advanceTimersByTimeAsync(10);

        // The attached tree shares the gateway's group. Signal descendants first,
        // then reverify their captured identities before the delayed force kill.
        expect(killSpy.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([
          [grandchildPid, "SIGTERM"],
          [childPid, "SIGTERM"],
          [rootPid, "SIGTERM"],
          [grandchildPid, "SIGKILL"],
          [childPid, "SIGKILL"],
          [rootPid, "SIGKILL"],
        ]);
        expect(killSpy.mock.calls.some(([pid]) => pid < 0)).toBe(false);
        expect(killSpy).not.toHaveBeenCalledWith(process.pid, expect.anything());
      });
    },
  );

  it("on Unix signals attached descendants before the root through signalProcessTree", async () => {
    const { rootPid, childPid } = createAttachedTreeFixture();
    killSpy.mockImplementation(() => true);
    mockProcTree({
      [rootPid]: { starttime: "100", children: [childPid] },
      [childPid]: { starttime: "101", ppid: rootPid },
    });
    await withMockedPlatform("linux", async () => {
      const completed = vi.fn();
      signalProcessTree(rootPid, "SIGTERM", { detached: false, onComplete: completed });
      expect(killSpy.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([
        [childPid, "SIGTERM"],
        [rootPid, "SIGTERM"],
      ]);
      expect(completed).toHaveBeenCalledOnce();
      expect(killSpy.mock.calls.some(([pid]) => pid < 0)).toBe(false);
    });
  });

  it("on Unix force-kills attached descendants before the root", async () => {
    const { rootPid, childPid } = createAttachedTreeFixture();
    killSpy.mockImplementation(() => true);
    mockProcTree({
      [rootPid]: { starttime: "100", children: [childPid] },
      [childPid]: { starttime: "101", ppid: rootPid },
    });
    await withMockedPlatform("linux", async () => {
      killProcessTree(rootPid, { force: true, detached: false });
      await vi.advanceTimersByTimeAsync(10);
      expect(killSpy.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([
        [childPid, "SIGKILL"],
        [rootPid, "SIGKILL"],
      ]);
      expect(killSpy.mock.calls.some(([pid]) => pid < 0)).toBe(false);
    });
  });

  it("on macOS signals only the attached root without a reusable process identity", async () => {
    killSpy.mockImplementation(() => true);

    await withMockedPlatform("darwin", async () => {
      signalProcessTree(5585, "SIGTERM", { detached: false });

      expect(killSpy).toHaveBeenCalledWith(5585, "SIGTERM");
      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(
        (killSpy.mock.calls as Array<[number, NodeJS.Signals | number | undefined]>).some(
          ([pid]) => typeof pid === "number" && pid < 0,
        ),
      ).toBe(false);
    });
  });

  it("on Unix skips recycled-PID escalation when the process instance changed", async () => {
    const { rootPid, childPid } = createAttachedTreeFixture();
    let rootStarttime = "100";
    killSpy.mockImplementation(() => true);
    mockProcTree({
      [rootPid]: { starttime: () => rootStarttime, children: [childPid] },
      [childPid]: { starttime: "101", ppid: rootPid },
    });
    await withMockedPlatform("linux", async () => {
      killProcessTree(rootPid, { graceMs: 10, detached: false });
      expect(killSpy.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([
        [childPid, "SIGTERM"],
        [rootPid, "SIGTERM"],
      ]);
      // A recycled root no longer owns the captured process identity.
      rootStarttime = "9999";
      await vi.advanceTimersByTimeAsync(10);
      expect(killSpy).not.toHaveBeenCalledWith(rootPid, "SIGKILL");
      expect(killSpy.mock.calls.some(([pid]) => pid < 0)).toBe(false);
    });
  });

  it("on Linux binds each child identity before traversing its own descendants", async () => {
    const { rootPid, childPid, grandchildPid } = createAttachedTreeFixture();
    killSpy.mockImplementation(() => true);
    mockProcTree({
      [rootPid]: { starttime: "100", children: [childPid] },
      // Its identity disappeared before capture. Do not read the replacement's children.
      [childPid]: { children: [grandchildPid] },
    });
    await withMockedPlatform("linux", async () => {
      killProcessTree(rootPid, { graceMs: 10, detached: false });
      await vi.advanceTimersByTimeAsync(10);
      expect(readFileSyncMock).toHaveBeenCalledWith(`/proc/${childPid}/stat`, "utf8");
      expect(readFileSyncMock).not.toHaveBeenCalledWith(
        `/proc/${childPid}/task/${childPid}/children`,
        "utf8",
      );
      expect(killSpy.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([
        [rootPid, "SIGTERM"],
        [rootPid, "SIGKILL"],
      ]);
      expect(killSpy).not.toHaveBeenCalledWith(childPid, expect.anything());
      expect(killSpy).not.toHaveBeenCalledWith(grandchildPid, expect.anything());
    });
  });

  it("on Linux rejects a recycled child PID whose replacement no longer belongs to the parent", async () => {
    const { rootPid, childPid, grandchildPid, foreignPid } = createAttachedTreeFixture();
    killSpy.mockImplementation(() => true);
    mockProcTree({
      [rootPid]: { starttime: "100", children: [childPid] },
      // A valid replacement identity still belongs to a different parent.
      [childPid]: { starttime: "888", ppid: foreignPid, children: [grandchildPid] },
      [grandchildPid]: { starttime: "889", ppid: childPid },
    });
    await withMockedPlatform("linux", async () => {
      killProcessTree(rootPid, { graceMs: 10, detached: false });
      await vi.advanceTimersByTimeAsync(10);
      expect(killSpy.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([
        [rootPid, "SIGTERM"],
        [rootPid, "SIGKILL"],
      ]);
      expect(killSpy).not.toHaveBeenCalledWith(childPid, expect.anything());
      expect(killSpy).not.toHaveBeenCalledWith(grandchildPid, expect.anything());
    });
  });

  it("on Linux revalidates a non-root parent before reading its children", async () => {
    const { rootPid, childPid, grandchildPid } = createAttachedTreeFixture();
    let childStarttime = "200";
    killSpy.mockImplementation(() => true);
    mockProcTree({
      [rootPid]: { starttime: "100", children: [childPid] },
      [childPid]: {
        ppid: rootPid,
        children: [grandchildPid],
        starttime: () => {
          // Capture sees the original process; revalidation sees its replacement.
          const captured = childStarttime;
          childStarttime = "777";
          return captured;
        },
      },
      [grandchildPid]: { starttime: "778", ppid: childPid },
    });
    await withMockedPlatform("linux", async () => {
      killProcessTree(rootPid, { graceMs: 10, detached: false });
      await vi.advanceTimersByTimeAsync(10);
      expect(killSpy.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([
        [rootPid, "SIGTERM"],
        [rootPid, "SIGKILL"],
      ]);
    });
  });

  it("on Linux revalidates the root identity before reading its children", async () => {
    const { rootPid, childPid } = createAttachedTreeFixture();
    let rootStarttime = "300";
    killSpy.mockImplementation(() => true);
    mockProcTree({
      [rootPid]: {
        children: [childPid],
        starttime: () => {
          const captured = rootStarttime;
          rootStarttime = "666";
          return captured;
        },
      },
      [childPid]: { starttime: "667", ppid: rootPid },
    });
    await withMockedPlatform("linux", async () => {
      killProcessTree(rootPid, { graceMs: 10, detached: false });
      await vi.advanceTimersByTimeAsync(10);
      // Neither the recycled root nor its replacement's child is authorized.
      expect(killSpy.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
    });
  });

  it("on Linux stops traversing once the PID cap is reached mid-list", async () => {
    const { rootPid } = createAttachedTreeFixture();
    const childPids = Array.from({ length: 4098 }, (_, i) => rootPid + i + 1);
    killSpy.mockImplementation(() => true);
    mockProcTree({
      [rootPid]: { starttime: "100", children: childPids },
      ...Object.fromEntries(
        childPids.map((pid) => [pid, { starttime: String(pid), ppid: rootPid }]),
      ),
    });
    await withMockedPlatform("linux", async () => {
      killProcessTree(rootPid, { graceMs: 10, detached: false });
      await vi.advanceTimersByTimeAsync(10);
      const probedChildStats = new Set(
        readFileSyncMock.mock.calls.flatMap(([file]) => {
          const match = String(file).match(/^\/proc\/(\d+)\/stat$/);
          return match && Number(match[1]) > rootPid ? [Number(match[1])] : [];
        }),
      );
      // The root fills one of 4096 slots. The next child must not even be probed.
      expect(probedChildStats.size).toBe(4095);
      expect(probedChildStats.has(childPids[4095]!)).toBe(false);
      const signaledChildren = killSpy.mock.calls
        .filter(([pid, signal]) => pid > rootPid && signal !== 0)
        .map(([pid]) => pid);
      expect(new Set(signaledChildren).size).toBe(4095);
      expect(readFileSyncMock).toHaveBeenCalledWith(
        `/proc/${rootPid}/task/${rootPid}/children`,
        "utf8",
      );
    });
  });

  it("on Linux rejects a child beyond the advertised depth cap", async () => {
    const { rootPid } = createAttachedTreeFixture();
    const chainPids = Array.from({ length: 129 }, (_, i) => rootPid + i);
    const overCapPid = rootPid + 129;
    killSpy.mockImplementation(() => true);
    mockProcTree(
      Object.fromEntries(
        [...chainPids, overCapPid].map((pid, index) => [
          pid,
          {
            starttime: String(100 + index),
            ppid: index === 0 ? 1 : pid - 1,
            children: pid === overCapPid ? [] : [pid + 1],
          },
        ]),
      ),
    );
    await withMockedPlatform("linux", async () => {
      killProcessTree(rootPid, { graceMs: 10, detached: false });
      await vi.advanceTimersByTimeAsync(10);
      // Reach the last permitted level; only its level-129 child is excluded.
      expect(killSpy).toHaveBeenCalledWith(overCapPid - 1, "SIGTERM");
      expect(readFileSyncMock).not.toHaveBeenCalledWith(`/proc/${overCapPid}/stat`, "utf8");
      expect(killSpy).not.toHaveBeenCalledWith(overCapPid, expect.anything());
    });
  });

  it("on Unix force-escalates one attached snapshot without rebuilding it", async () => {
    const { rootPid, childPid } = createAttachedTreeFixture();
    killSpy.mockImplementation(() => true);
    mockProcTree({
      [rootPid]: { starttime: "100", children: [childPid] },
      [childPid]: { starttime: "101", ppid: rootPid },
    });
    await withMockedPlatform("linux", async () => {
      const termination = killProcessTree(rootPid, { graceMs: 10, detached: false });
      termination?.force();
      await vi.advanceTimersByTimeAsync(10);
      expect(killSpy.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([
        [childPid, "SIGTERM"],
        [rootPid, "SIGTERM"],
        [childPid, "SIGKILL"],
        [rootPid, "SIGKILL"],
      ]);
    });
  });

  it("on Unix skips an attached descendant without an identity during escalation", async () => {
    const { rootPid, childPid } = createAttachedTreeFixture();
    killSpy.mockImplementation(() => true);
    mockProcTree({
      [rootPid]: { starttime: "100", children: [childPid] },
      [childPid]: {},
    });
    await withMockedPlatform("linux", async () => {
      killProcessTree(rootPid, { graceMs: 10, detached: false });
      await vi.advanceTimersByTimeAsync(10);
      expect(killSpy).not.toHaveBeenCalledWith(childPid, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(childPid, "SIGKILL");
      expect(killSpy).toHaveBeenCalledWith(rootPid, "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(rootPid, "SIGKILL");
    });
  });

  it.each([
    { force: false, signal: "SIGTERM", expired: false },
    { force: true, signal: "SIGKILL", expired: false },
    { force: false, signal: "SIGTERM", expired: true },
    { force: true, signal: "SIGKILL", expired: true },
  ] as const)(
    "on Linux immediately signals only the owned root when identity capture fails: %j",
    async ({ force, signal, expired }) => {
      killSpy.mockImplementation(() => true);
      readFileSyncMock.mockImplementation(() => {
        if (!expired) {
          throw new Error("root identity unavailable");
        }
        vi.setSystemTime(Date.now() + 501);
        return "5594 (root) S 1 5594 5594 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 100 0";
      });

      await withMockedPlatform("linux", async () => {
        const handle = killProcessTree(5594, { force, graceMs: 10, detached: false });
        expect(handle).toBeUndefined();
        expect(killSpy.mock.calls).toEqual([[5594, signal]]);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(killSpy.mock.calls).toEqual([[5594, signal]]);
      });
    },
  );

  it("on Unix keeps an attached descendant snapshot after its root exits", async () => {
    const { rootPid, childPid } = createAttachedTreeFixture();
    let rootAlive = true;
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0 && pid === rootPid && !rootAlive) {
        throw new Error("ESRCH");
      }
      return true;
    }) as typeof process.kill);
    mockProcTree({
      [rootPid]: { starttime: "100", children: [childPid] },
      [childPid]: { starttime: "101", ppid: rootPid },
    });
    await withMockedPlatform("linux", async () => {
      killProcessTree(rootPid, { graceMs: 10, detached: false });
      rootAlive = false;
      await vi.advanceTimersByTimeAsync(10);
      expect(killSpy).toHaveBeenCalledWith(childPid, "SIGKILL");
      expect(killSpy).not.toHaveBeenCalledWith(rootPid, "SIGKILL");
    });
  });

  it("on Unix force-kills only the verified root when attached descendants cannot be enumerated", async () => {
    killSpy.mockImplementation(() => true);
    readFileSyncMock.mockImplementation((filePath: string) => {
      if (filePath === "/proc/5555/stat") {
        return "5555 (root) S 1 5555 5555 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 100 0";
      }
      throw new Error("descendant enumeration unavailable");
    });

    await withMockedPlatform("linux", async () => {
      killProcessTree(5555, { graceMs: 10, detached: false });
      await vi.advanceTimersByTimeAsync(10);

      expect(killSpy).toHaveBeenCalledWith(5555, "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(5555, "SIGKILL");
      expect(
        (killSpy.mock.calls as Array<[number, NodeJS.Signals | number | undefined]>).some(
          ([pid]) => typeof pid === "number" && pid < 0,
        ),
      ).toBe(false);
    });
  });

  it("on Unix uses group kill when the omitted option resolves to a group leader", async () => {
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -6666 && signal === 0) {
        throw new Error("ESRCH");
      }
      if (pid === 6666 && signal === 0) {
        throw new Error("ESRCH");
      }
      return true;
    }) as typeof process.kill);

    await withMockedPlatform("linux", async () => {
      mockIsProcessGroupLeader(6666);
      killProcessTree(6666, { graceMs: 10 });
      await vi.advanceTimersByTimeAsync(10);

      expect(killSpy).toHaveBeenCalledWith(-6666, "SIGTERM");
    });
  });

  it.each([
    [
      "throws",
      () => {
        throw new Error("ps ENOENT");
      },
    ],
    ["exits non-zero", () => ({ status: 1, stdout: "" })],
    ["returns non-numeric output", () => ({ status: 0, stdout: "not-a-pgid" })],
    ["returns empty output", () => ({ status: 0, stdout: "" })],
  ])("on Unix falls back to single-pid kill when ps %s", async (_label, psResult) => {
    killSpy.mockImplementation(() => true);

    await withMockedPlatform("darwin", async () => {
      spawnSyncMock.mockImplementation(psResult);
      killProcessTree(8888, { graceMs: 10 });
      await vi.advanceTimersByTimeAsync(10);

      expect(killSpy).toHaveBeenCalledWith(8888, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(-8888, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(-8888, "SIGKILL");
    });
  });

  it("on Unix falls back to single-pid kill when ps returns different PGID", async () => {
    killSpy.mockImplementation(() => true);

    await withMockedPlatform("linux", async () => {
      spawnSyncMock.mockImplementation((command: string, args: string[]) => {
        if (command === "ps" && args[0] === "-p" && args[2] === "-o" && args[3] === "pgid=") {
          const pid = Number.parseInt(args[1] ?? "", 10);
          if (pid === 9999) {
            return { status: 0, stdout: "12345\n" };
          }
        }
        return { status: 1, stdout: "" };
      });
      killProcessTree(9999, { graceMs: 10 });
      await vi.advanceTimersByTimeAsync(10);

      expect(killSpy).toHaveBeenCalledWith(9999, "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(9999, "SIGKILL");
      expect(killSpy).not.toHaveBeenCalledWith(-9999, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(-9999, "SIGKILL");
    });
  });

  it("on Linux reads process-group ownership from procfs without spawning ps", async () => {
    killSpy.mockImplementation(() => true);
    readFileSyncMock.mockReturnValue("7777 (shell worker) S 1 7777 7777 0");

    await withMockedPlatform("linux", async () => {
      signalProcessTree(7777, "SIGTERM");

      expect(killSpy).toHaveBeenCalledWith(-7777, "SIGTERM");
      expect(spawnSyncMock).not.toHaveBeenCalled();
    });
  });

  it.each([false, true])(
    "on Unix keeps a requested signal group-only (group missing: %s)",
    async (missing) => {
      killSpy.mockImplementation((pid: number) => {
        if (pid === -7777 && missing) {
          throw new Error("ESRCH");
        }
        return true;
      });

      await withMockedPlatform("linux", async () => {
        mockIsProcessGroupLeader(7777);
        signalProcessTree(7777, "SIGTERM");

        await vi.advanceTimersByTimeAsync(60_000);

        expect(killSpy).toHaveBeenCalledTimes(1);
        expect(killSpy).toHaveBeenCalledWith(-7777, "SIGTERM");
        expect(killSpy).not.toHaveBeenCalledWith(-7777, "SIGKILL");
      });
    },
  );

  it("rescans a PTY session for job-control groups created after the first snapshot", async () => {
    killSpy.mockImplementation(() => true);
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "ttys001\n" })
      .mockReturnValueOnce({ status: 0, stdout: "9000 9000\n9001 9001\n" })
      .mockReturnValueOnce({ status: 0, stdout: "9002 9002\n" });

    await withMockedPlatform("darwin", async () => {
      signalPtySessionTree(9000, "SIGKILL");

      expect(spawnSyncMock).toHaveBeenCalledTimes(3);
      expect(spawnSyncMock.mock.calls[1]?.[1]).toEqual(["-t", "ttys001", "-o", "pid=,pgid="]);
      expect(spawnSyncMock.mock.calls[2]?.[1]).toEqual(spawnSyncMock.mock.calls[1]?.[1]);
      expect(killSpy).toHaveBeenCalledWith(-9002, "SIGKILL");
      expect(killSpy).toHaveBeenCalledWith(9002, "SIGKILL");
      const leaderGroupCall = killSpy.mock.calls.findIndex((call: unknown[]) => call[0] === -9000);
      expect(spawnSyncMock.mock.invocationCallOrder[2]).toBeLessThan(
        killSpy.mock.invocationCallOrder[leaderGroupCall]!,
      );
    });
  });

  it("on Windows maps requested tree signals to taskkill force mode", async () => {
    await withMockedPlatform("win32", async () => {
      signalProcessTree(8888, "SIGTERM");
      signalProcessTree(8888, "SIGKILL");

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expectTaskkillCall(0, ["/T", "/PID", "8888"]);
      expectTaskkillCall(1, ["/F", "/T", "/PID", "8888"]);
    });
  });

  it("on Windows exposes taskkill completion", async () => {
    const taskkillChild = new EventEmitter();
    spawnMock.mockReturnValueOnce(taskkillChild);

    await withMockedPlatform("win32", async () => {
      const completed = vi.fn();
      signalProcessTree(8989, "SIGKILL", { onComplete: completed });
      await Promise.resolve();
      expect(completed).not.toHaveBeenCalled();

      taskkillChild.emit("close", 0);
      await Promise.resolve();

      expect(completed).toHaveBeenCalledOnce();
      expectTaskkillCall(0, ["/F", "/T", "/PID", "8989"]);
    });
  });

  it("on Windows bounds taskkill completion when no event arrives", async () => {
    const taskkillChild = new EventEmitter();
    spawnMock.mockReturnValueOnce(taskkillChild);

    await withMockedPlatform("win32", async () => {
      const completed = vi.fn();
      signalProcessTree(9090, "SIGKILL", { onComplete: completed });

      await vi.advanceTimersByTimeAsync(2_999);
      expect(completed).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(completed).toHaveBeenCalledOnce();
      expectTaskkillCall(0, ["/F", "/T", "/PID", "9090"]);
    });
  });

  it("on Windows force-kills synchronously without delayed taskkill", async () => {
    await withMockedPlatform("win32", async () => {
      killProcessTree(9999, { force: true });
      await vi.advanceTimersByTimeAsync(60_000);

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expectTaskkillCall(0, ["/F", "/T", "/PID", "9999"]);
    });
  });

  it("on Windows ignores async taskkill spawn errors", async () => {
    const taskkillChild = new EventEmitter();
    spawnMock.mockReturnValueOnce(taskkillChild);

    await withMockedPlatform("win32", async () => {
      killProcessTree(9191, { force: true });

      expect(() => taskkillChild.emit("error", new Error("spawn ENOENT"))).not.toThrow();
      expectTaskkillCall(0, ["/F", "/T", "/PID", "9191"]);
    });
  });
});
