// Kill tree tests cover process tree termination and platform-specific fallbacks.
import { EventEmitter } from "node:events";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";

const { readFileSyncMock, spawnMock, spawnSyncMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

vi.mock("node:fs", () => ({
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

describe("killProcessTree", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    ({ killProcessTree, signalProcessTree } = await import("./kill-tree.js"));
  });

  beforeEach(() => {
    readFileSyncMock.mockReset();
    readFileSyncMock.mockImplementation(() => {
      throw new Error("proc unavailable");
    });
    // mockReset (not mockClear) also drains queued mockReturnValueOnce children.
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

  it("on Unix sends SIGTERM first and skips SIGKILL when process exits", async () => {
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -3333 && signal === 0) {
        throw new Error("ESRCH");
      }
      if (pid === 3333 && signal === 0) {
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
    });
  });

  it("on Unix sends SIGKILL after grace period when process is still alive", async () => {
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -4444 && signal === 0) {
        return true;
      }
      return true;
    }) as typeof process.kill);

    await withMockedPlatform("linux", async () => {
      mockIsProcessGroupLeader(4444);
      killProcessTree(4444, { graceMs: 5 });

      await vi.advanceTimersByTimeAsync(5);

      expect(killSpy).toHaveBeenCalledWith(-4444, "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(-4444, "SIGKILL");
    });
  });

  it("on Unix force-kills synchronously without SIGTERM or delayed escalation", async () => {
    killSpy.mockImplementation(() => true);

    await withMockedPlatform("linux", async () => {
      mockIsProcessGroupLeader(4949);
      killProcessTree(4949, { force: true });
      await vi.advanceTimersByTimeAsync(60_000);

      expect(killSpy).toHaveBeenCalledTimes(1);
      expect(killSpy).toHaveBeenCalledWith(-4949, "SIGKILL");
      expect(killSpy).not.toHaveBeenCalledWith(-4949, "SIGTERM");
    });
  });

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
      mockIsProcessGroupLeader(4545);
      killProcessTree(4545, { graceMs: 5 });

      await vi.advanceTimersByTimeAsync(5);

      expect(killSpy).toHaveBeenCalledWith(-4545, "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(-4545, "SIGKILL");
      expect(killSpy).not.toHaveBeenCalledWith(4545, "SIGKILL");
    });
  });

  it("on Unix skips group kill when detached:false to avoid SIGTERMing the parent's own process group (#71662)", async () => {
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 5555 && signal === 0) {
        throw new Error("ESRCH");
      }
      return true;
    }) as typeof process.kill);

    await withMockedPlatform("linux", async () => {
      killProcessTree(5555, { graceMs: 10, detached: false });
      await vi.advanceTimersByTimeAsync(10);

      // Direct pid kill is fine. Group kill (`-pid`) is FORBIDDEN here because
      // when the child wasn't spawned detached, its process group is the
      // gateway's group — `-pid` would SIGTERM the gateway itself.
      expect(killSpy).toHaveBeenCalledWith(5555, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(-5555, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(-5555, "SIGKILL");
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

  it("on Unix sends a single requested tree signal without scheduling escalation", async () => {
    killSpy.mockImplementation(() => true);

    await withMockedPlatform("linux", async () => {
      mockIsProcessGroupLeader(7777);
      signalProcessTree(7777, "SIGTERM");

      await vi.advanceTimersByTimeAsync(60_000);

      expect(killSpy).toHaveBeenCalledTimes(1);
      expect(killSpy).toHaveBeenCalledWith(-7777, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(-7777, "SIGKILL");
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

  // Windows refuses to end console processes without /F and reports exit 128. Without
  // escalating on that result, cleanup relies solely on the unref'd grace timer, which a
  // gateway restart inside the grace window cancels — leaking the whole tree (#110789).
  it("on Windows force-kills immediately when graceful taskkill reports failure and the PID is still alive", async () => {
    const graceful = new EventEmitter();
    spawnMock.mockReturnValueOnce(graceful);
    killSpy.mockImplementation(() => true);

    await withMockedPlatform("win32", async () => {
      killProcessTree(4711, { graceMs: 30_000 });

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expectTaskkillCall(0, ["/T", "/PID", "4711"]);

      graceful.emit("close", 128);

      // Escalates on the reported failure, without waiting out the 30s grace window.
      expect(spawnMock).toHaveBeenCalledTimes(2);
      expectTaskkillCall(1, ["/F", "/T", "/PID", "4711"]);
    });
  });

  // taskkill reports the same non-zero exit for "can only be terminated forcefully" and
  // "process not found", so a reported failure alone must not authorize /F: Windows reuses
  // PIDs, and /T against a reused number would tear down an unrelated tree.
  it("on Windows does not force-kill when graceful taskkill fails but the PID is already gone", async () => {
    const graceful = new EventEmitter();
    spawnMock.mockReturnValueOnce(graceful);
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 4717 && signal === 0) {
        throw new Error("ESRCH");
      }
      return true;
    }) as typeof process.kill);

    await withMockedPlatform("win32", async () => {
      killProcessTree(4717, { graceMs: 30 });

      graceful.emit("close", 128);
      expect(spawnMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30);
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
  });

  // taskkill /T without /F returns 0 once it has sent WM_CLOSE, which a GUI tree may ignore.
  it("on Windows force-kills once via the grace timer when taskkill succeeds but the tree survives", async () => {
    const graceful = new EventEmitter();
    spawnMock.mockReturnValueOnce(graceful);
    killSpy.mockImplementation(() => true);

    await withMockedPlatform("win32", async () => {
      killProcessTree(4718, { graceMs: 30 });

      graceful.emit("close", 0);
      expect(spawnMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30);

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expectTaskkillCall(1, ["/F", "/T", "/PID", "4718"]);
    });
  });

  it("on Windows does not force-kill when graceful taskkill succeeds", async () => {
    const graceful = new EventEmitter();
    spawnMock.mockReturnValueOnce(graceful);
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 4712 && signal === 0) {
        throw new Error("ESRCH");
      }
      return true;
    }) as typeof process.kill);

    await withMockedPlatform("win32", async () => {
      killProcessTree(4712, { graceMs: 25 });
      graceful.emit("close", 0);

      expect(spawnMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(25);
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
  });

  it("on Windows falls back to the grace timer when graceful taskkill never reports", async () => {
    const graceful = new EventEmitter();
    spawnMock.mockReturnValueOnce(graceful);
    killSpy.mockImplementation(() => true);

    await withMockedPlatform("win32", async () => {
      killProcessTree(4713, { graceMs: 40 });

      expect(spawnMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(40);

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expectTaskkillCall(1, ["/F", "/T", "/PID", "4713"]);
    });
  });

  it("on Windows forces at most once when the failure and grace timer both fire", async () => {
    const graceful = new EventEmitter();
    spawnMock.mockReturnValueOnce(graceful);
    killSpy.mockImplementation(() => true);

    await withMockedPlatform("win32", async () => {
      killProcessTree(4714, { graceMs: 20 });
      graceful.emit("close", 1);

      expect(spawnMock).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(20);

      expect(spawnMock).toHaveBeenCalledTimes(2);
    });
  });

  // A failed spawn emits "error" and then "close" carrying a negative errno (ENOENT is
  // -4058 on Windows). Only the first outcome counts, so the follow-up close must not read
  // as a non-zero taskkill verdict and escalate on its own.
  it("on Windows does not escalate immediately when the graceful taskkill spawn errors", async () => {
    const graceful = new EventEmitter();
    spawnMock.mockReturnValueOnce(graceful);
    killSpy.mockImplementation(() => true);

    await withMockedPlatform("win32", async () => {
      killProcessTree(4715, { graceMs: 15 });

      expect(() => graceful.emit("error", new Error("spawn ENOENT"))).not.toThrow();
      graceful.emit("close", -4058);
      expect(spawnMock).toHaveBeenCalledTimes(1);

      // The grace timer remains the backstop for a tree that is still alive.
      await vi.advanceTimersByTimeAsync(15);
      expect(spawnMock).toHaveBeenCalledTimes(2);
      expectTaskkillCall(1, ["/F", "/T", "/PID", "4715"]);
    });
  });

  // signalProcessTree is the explicit one-shot API; escalation belongs to killProcessTree only.
  it("on Windows keeps signalProcessTree SIGTERM single-shot when taskkill fails", async () => {
    const graceful = new EventEmitter();
    spawnMock.mockReturnValueOnce(graceful);

    await withMockedPlatform("win32", async () => {
      signalProcessTree(4716, "SIGTERM");
      expectTaskkillCall(0, ["/T", "/PID", "4716"]);

      graceful.emit("close", 128);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
  });
});
