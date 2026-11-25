import childProcess, { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { attachChildProcessBridge } from "./child-process-bridge.js";

vi.mock("./child-process-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./child-process-bridge.js")>()),
  attachChildProcessBridge: vi.fn(),
}));

const signalProcessTreeMock = vi.hoisted(() => vi.fn());
vi.mock("./kill-tree.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./kill-tree.js")>()),
  signalProcessTree: signalProcessTreeMock,
}));
import { runRespawnChildWithSignalBridge } from "./respawn-child-runner.js";
const runs: Array<{ child: ChildProcess; completion: Promise<number> }> = [];
const ttyStreams = [process.stdin, process.stdout].map((stream) => ({
  stream,
  descriptor: Object.getOwnPropertyDescriptor(stream, "isTTY"),
}));
let killProcess: MockInstance<typeof process.kill>;
function start(
  options: {
    pid?: number;
    detached?: boolean;
    onError?: (error: unknown) => void | Promise<void>;
  } = {},
) {
  const child = Object.assign(new ChildProcess(), { pid: options.pid });
  const kill = vi.spyOn(child, "kill").mockReturnValue(true);
  vi.spyOn(childProcess, "spawn").mockReturnValue(child);
  const detach = vi.fn();
  let onSignal: ((signal: NodeJS.Signals) => void) | undefined;
  const onError = vi.fn(options.onError ?? (() => {}));
  vi.mocked(attachChildProcessBridge).mockImplementation((_child, signalHandler) => {
    onSignal = signalHandler;
    return { detach };
  });
  const completion = runRespawnChildWithSignalBridge({
    command: "/usr/bin/node",
    args: ["/repo/openclaw/dist/entry.js"],
    env: { OPENCLAW_NODE_OPTIONS_READY: "1" },
    onError,
    detachForProcessTree: options.detached,
  });
  runs.push({ child, completion });
  const settled = vi.fn();
  void completion.then(settled);
  return {
    child,
    kill,
    detach,
    onError,
    completion,
    settled,
    signal: (value: NodeJS.Signals) => onSignal?.(value),
  };
}
beforeEach(() => {
  for (const { stream } of ttyStreams) {
    Object.defineProperty(stream, "isTTY", { configurable: true, value: false });
  }
  signalProcessTreeMock.mockReset();
  vi.mocked(attachChildProcessBridge).mockReset();
  killProcess = vi.spyOn(process, "kill").mockReturnValue(true);
});
afterEach(async () => {
  for (const run of runs) {
    run.child.emit("close", 0, null);
  }
  await Promise.all(runs.splice(0).map((run) => run.completion));
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const { stream, descriptor } of ttyStreams) {
    if (descriptor) {
      Object.defineProperty(stream, "isTTY", descriptor);
    } else {
      Reflect.deleteProperty(stream, "isTTY");
    }
  }
});
it.each([
  ["SIGINT", "SIGINT", "SIGTERM", 130, 130],
  ["SIGTERM", "SIGTERM", "SIGINT", 143, 143],
  ["SIGTERM", "SIGINT", undefined, 1, 143],
] as const)(
  "settles actual %s status only after close (first=%s, later=%s)",
  async (signal, firstSignal, laterSignal, windowsCode, posixCode) => {
    const run = start({ pid: 2345 });
    run.signal(firstSignal);
    if (laterSignal) {
      run.signal(laterSignal);
    }
    run.child.emit("exit", null, signal);
    await Promise.resolve();
    for (const mock of [run.settled, run.detach, killProcess]) {
      expect(mock).not.toHaveBeenCalled();
    }
    run.child.emit("close", null, signal);
    await expect(run.completion).resolves.toBe(
      process.platform === "win32" ? windowsCode : posixCode,
    );
    expect(run.detach).toHaveBeenCalledOnce();
    if (process.platform === "win32") {
      expect(killProcess).not.toHaveBeenCalled();
    } else {
      expect(killProcess).toHaveBeenCalledExactlyOnceWith(process.pid, signal);
      expect(run.detach).toHaveBeenCalledBefore(killProcess);
    }
  },
);

it.each([false, true])("escalates detached=%s after grace and joins close", async (detached) => {
  vi.useFakeTimers();
  const run = start({ pid: 2468, detached });
  run.signal("SIGTERM");
  if (!detached) {
    run.child.emit("error", new Error("first signal delivery failed"));
    run.child.emit("error", new Error("second signal delivery failed"));
  }
  const tree = detached && process.platform !== "win32";
  vi.advanceTimersByTime(1_000);
  expect(signalProcessTreeMock.mock.calls).toEqual(
    tree ? [[2468, "SIGTERM", { detached: true }]] : [],
  );
  expect(run.kill.mock.calls).toEqual(tree ? [] : [["SIGTERM"]]);
  vi.advanceTimersByTime(1_000);
  if (tree) {
    expect(signalProcessTreeMock).toHaveBeenCalledWith(2468, "SIGKILL", { detached: true });
  } else {
    expect(run.kill.mock.calls).toEqual([
      ["SIGTERM"],
      [process.platform === "win32" ? "SIGTERM" : "SIGKILL"],
    ]);
  }
  vi.advanceTimersByTime(1_000);
  expect([killProcess.mock.calls, run.onError.mock.calls]).toEqual([[], []]);
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
  expect(signalProcessTreeMock.mock.calls).toEqual(
    process.platform === "win32" ? [] : [[3579, "SIGKILL", { detached: true }]],
  );
  expect(run.kill).not.toHaveBeenCalled();
  run.signal("SIGTERM");
  vi.advanceTimersByTime(3_000);
  expect(run.kill).not.toHaveBeenCalled();
  run.child.emit("close", 0, null);
  await expect(run.completion).resolves.toBe(0);
});

it.each(["reject", "throw"] as const)("joins close and diagnostics: %s", async (settlement) => {
  const reporting = createDeferredCore();
  const run = start({
    onError: () => {
      if (settlement === "throw") {
        throw new Error("formatter unavailable");
      }
      return reporting.promise;
    },
  });
  const error = new Error("spawn failed");
  try {
    run.child.emit("error", error);
    expect(run.onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(run.settled).not.toHaveBeenCalled();
    run.child.emit("close", -2, null);
    await Promise.resolve();
    if (settlement === "reject") {
      expect(run.settled).not.toHaveBeenCalled();
      reporting.reject(new Error("formatter unavailable"));
    }
    await expect(run.completion).resolves.toBe(1);
  } finally {
    reporting.resolve();
  }
});
