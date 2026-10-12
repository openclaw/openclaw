// Respawn child runner tests cover signal forwarding and process-tree cleanup.
import childProcess, { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";

const signalProcessTreeMock = vi.hoisted(() => vi.fn());
vi.mock("./kill-tree.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./kill-tree.js")>()),
  signalProcessTree: signalProcessTreeMock,
}));
import { runRespawnChildWithSignalBridge } from "./respawn-child-runner.js";

const runs: Array<{ child: ChildProcess; completion: Promise<number> }> = [];
let killProcess: MockInstance<typeof process.kill>;
function start(
  options: {
    pid?: number;
    detached?: boolean;
    terminal?: boolean;
    onError?: (error: unknown) => void | Promise<void>;
  } = {},
) {
  const child = Object.assign(new ChildProcess(), { pid: options.pid });
  const kill = vi.spyOn(child, "kill").mockReturnValue(true);
  const spawn = vi.spyOn(childProcess, "spawn").mockReturnValue(child);
  const detach = vi.fn();
  let onSignal: ((signal: NodeJS.Signals) => void) | undefined;
  const onError = vi.fn(options.onError ?? (() => {}));
  const completion = runRespawnChildWithSignalBridge({
    command: "/usr/bin/node",
    args: ["/repo/openclaw/dist/entry.js"],
    env: { OPENCLAW_NODE_OPTIONS_READY: "1" },
    detachForProcessTree: options.detached,
    stdioIsTerminal: options.terminal ?? false,
    runtime: {
      spawn: childProcess.spawn,
      attachChildProcessBridge: (_child, bridgeOptions) => {
        onSignal = bridgeOptions?.onSignal;
        return { detach };
      },
    },
    onError,
  });
  runs.push({ child, completion });
  return {
    child,
    kill,
    spawn,
    detach,
    onError,
    completion,
    signal: (value: NodeJS.Signals) => onSignal?.(value),
  };
}

beforeEach(() => {
  signalProcessTreeMock.mockReset();
  killProcess = vi.spyOn(process, "kill").mockReturnValue(true);
});
afterEach(async () => {
  for (const run of runs) {
    run.child.emit("close", 0, null);
  }
  await Promise.all(runs.splice(0).map((run) => run.completion));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runRespawnChildWithSignalBridge", () => {
  it.each([false, true])(
    "owns the respawn group only without terminal stdio (terminal=%s)",
    async (terminal) => {
      const run = start({ pid: 1234, detached: true, terminal });
      expect(run.spawn).toHaveBeenCalledWith("/usr/bin/node", ["/repo/openclaw/dist/entry.js"], {
        stdio: "inherit",
        env: { OPENCLAW_NODE_OPTIONS_READY: "1" },
        detached: process.platform !== "win32" && !terminal,
        windowsHide: !terminal,
      });
      run.child.emit("close", 0, null);
      await expect(run.completion).resolves.toBe(0);
      expect(run.detach).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      signal: "SIGINT",
      firstSignal: "SIGINT",
      laterSignal: "SIGTERM",
      windowsCode: 130,
      posixCode: 130,
    },
    {
      signal: "SIGTERM",
      firstSignal: "SIGTERM",
      laterSignal: "SIGINT",
      windowsCode: 143,
      posixCode: 143,
    },
    {
      signal: "SIGTERM",
      firstSignal: "SIGINT",
      laterSignal: undefined,
      windowsCode: 1,
      posixCode: 143,
    },
    {
      signal: "SIGKILL",
      firstSignal: undefined,
      laterSignal: undefined,
      windowsCode: 1,
      posixCode: 137,
    },
  ] as const)(
    "settles actual $signal status only after close (first=$firstSignal)",
    async (testCase) => {
      const run = start({ pid: 2345 });
      let settled = false;
      void run.completion.then(() => {
        settled = true;
      });
      if (testCase.firstSignal) {
        run.signal(testCase.firstSignal);
      }
      if (testCase.laterSignal) {
        run.signal(testCase.laterSignal);
      }
      run.child.emit("exit", null, testCase.signal);
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(run.detach).not.toHaveBeenCalled();
      expect(killProcess).not.toHaveBeenCalled();
      run.child.emit("close", null, testCase.signal);
      await expect(run.completion).resolves.toBe(
        process.platform === "win32" ? testCase.windowsCode : testCase.posixCode,
      );
      expect(run.detach).toHaveBeenCalledOnce();
      if (process.platform === "win32") {
        expect(killProcess).not.toHaveBeenCalled();
      } else {
        expect(killProcess).toHaveBeenCalledExactlyOnceWith(process.pid, testCase.signal);
        expect(run.detach).toHaveBeenCalledBefore(killProcess);
      }
    },
  );

  it("reaps only the detached child group after its signal grace, then waits for close", async () => {
    vi.useFakeTimers();
    const run = start({ pid: 2468, detached: true });
    run.signal("SIGTERM");
    vi.advanceTimersByTime(1_000);
    if (process.platform === "win32") {
      expect(signalProcessTreeMock).not.toHaveBeenCalled();
      expect(run.kill).toHaveBeenCalledWith("SIGTERM");
    } else {
      expect(signalProcessTreeMock).toHaveBeenCalledWith(2468, "SIGTERM", { detached: true });
      expect(run.kill).not.toHaveBeenCalled();
    }
    vi.advanceTimersByTime(1_000);
    if (process.platform === "win32") {
      expect(run.kill).toHaveBeenCalledTimes(2);
    } else {
      expect(signalProcessTreeMock).toHaveBeenCalledWith(2468, "SIGKILL", { detached: true });
    }
    vi.advanceTimersByTime(1_000);
    expect(killProcess).not.toHaveBeenCalled();
    run.child.emit("exit", null, "SIGKILL");
    expect(run.detach).not.toHaveBeenCalled();
    run.child.emit("close", null, "SIGKILL");
    await expect(run.completion).resolves.toBe(process.platform === "win32" ? 1 : 137);
  });

  it("reaps detached descendants when their root exits after a parent signal", async () => {
    vi.useFakeTimers();
    const run = start({ pid: 3579, detached: true });
    run.signal("SIGTERM");
    run.child.emit("exit", 0, null);
    if (process.platform === "win32") {
      expect(signalProcessTreeMock).not.toHaveBeenCalled();
    } else {
      expect(signalProcessTreeMock).toHaveBeenCalledExactlyOnceWith(3579, "SIGKILL", {
        detached: true,
      });
    }
    expect(run.kill).not.toHaveBeenCalled();
    run.signal("SIGTERM");
    vi.advanceTimersByTime(3_000);
    expect(run.kill).not.toHaveBeenCalled();
    run.child.emit("close", 0, null);
    await expect(run.completion).resolves.toBe(0);
  });

  it.each(["resolve", "reject", "throw"] as const)(
    "waits for close and diagnostic settlement (%s)",
    async (settlement) => {
      const reporting = createDeferredCore();
      const run = start({
        onError: () => {
          if (settlement === "throw") {
            throw new Error("formatter unavailable");
          }
          return reporting.promise;
        },
      });
      let settled = false;
      void run.completion.then(() => {
        settled = true;
      });
      const error = new Error("spawn failed");
      try {
        run.child.emit("error", error);
        expect(run.onError).toHaveBeenCalledExactlyOnceWith(error);
        expect(settled).toBe(false);
        run.child.emit("close", -2, null);
        await Promise.resolve();
        if (settlement !== "throw") {
          expect(settled).toBe(false);
        }
        if (settlement === "reject") {
          reporting.reject(new Error("formatter unavailable"));
        } else {
          reporting.resolve();
        }
        await expect(run.completion).resolves.toBe(1);
      } finally {
        reporting.resolve();
      }
    },
  );

  it("preserves synchronous spawn exceptions without starting diagnostics", () => {
    const error = new Error("invalid spawn options");
    const onError = vi.fn();
    vi.spyOn(childProcess, "spawn").mockImplementation(() => {
      throw error;
    });
    expect(() =>
      runRespawnChildWithSignalBridge({
        command: "node",
        args: [],
        env: {},
        runtime: {
          spawn: childProcess.spawn,
          attachChildProcessBridge: vi.fn(),
        },
        onError,
      }),
    ).toThrow(error);
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps escalation active across repeated operational errors", async () => {
    vi.useFakeTimers();
    const run = start({ pid: 5678 });
    run.signal("SIGTERM");
    run.child.emit("error", new Error("first signal delivery failed"));
    run.child.emit("error", new Error("second signal delivery failed"));
    vi.advanceTimersByTime(2_000);
    expect(run.onError).not.toHaveBeenCalled();
    expect(run.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(run.kill).toHaveBeenNthCalledWith(
      2,
      process.platform === "win32" ? "SIGTERM" : "SIGKILL",
    );
    run.child.emit("exit", null, "SIGKILL");
    run.child.emit("close", null, "SIGKILL");
    await expect(run.completion).resolves.toBe(process.platform === "win32" ? 1 : 137);
  });
});
