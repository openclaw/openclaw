import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { runWatch, watchReady } from "./watch-node.test-support.js";

class FakeProcess extends EventEmitter {
  execPath = process.execPath;
  pid = 12345;
}

class FakeChild extends EventEmitter {
  signals: string[] = [];
  constructor(public pid?: number) {
    super();
  }

  kill(signal: string): boolean {
    this.signals.push(signal);
    if (signal === "SIGKILL") {
      this.emit("exit", null, "SIGKILL");
    }
    return true;
  }
}

afterEach(() => vi.useRealTimers());

function start(
  children: FakeChild[],
  signalProcess?: (pid: number, signal: NodeJS.Signals | 0) => void,
  env?: NodeJS.ProcessEnv,
) {
  vi.useFakeTimers();
  const fakeProcess = new FakeProcess();
  const run = runWatch({
    args: ["gateway"],
    createWatcher: () => ({ close: async () => {} }),
    env,
    process: fakeProcess as unknown as NodeJS.Process,
    signalProcess,
    spawn: () => children.shift() as never,
  });
  return { run, fakeProcess };
}

async function expectEscalation({ run, fakeProcess }: ReturnType<typeof start>, child: FakeChild) {
  let resolvedCode: Awaited<typeof run> | undefined;
  const settled = run.then((code) => (resolvedCode = code));
  fakeProcess.emit("SIGTERM");
  await vi.advanceTimersByTimeAsync(4_999);
  expect(resolvedCode).toBeUndefined();
  expect(child.signals).toEqual(["SIGTERM"]);

  await vi.advanceTimersByTimeAsync(1);
  await expect(settled).resolves.toBe(process.platform === "win32" ? 143 : "SIGKILL");
  expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
}

it.each([false, true])(
  "waits and escalates when the child ignores SIGTERM (repair=%s)",
  async (repair) => {
    const runner = new FakeChild();
    const child = repair ? new FakeChild() : runner;
    const children = repair ? [runner, child] : [child];
    const watch = start(children, undefined, repair ? {} : undefined);
    await watchReady();
    if (repair) {
      runner.emit("exit", 1, null);
      expect(children).toHaveLength(0);
      await watchReady();
    }
    await expectEscalation(watch, child);
  },
);

it("force-cleans the child process group when the leader exits after shutdown", async () => {
  const child = new FakeChild(4_242);
  const groupSignals: Array<[number, string | number]> = [];
  const { run, fakeProcess } = start([child], (pid, signal) => {
    groupSignals.push([pid, signal]);
  });

  await watchReady();
  fakeProcess.emit("SIGTERM");
  expect(groupSignals).toEqual([[-4_242, "SIGTERM"]]);
  child.emit("exit", 0, null);

  await expect(run).resolves.toBe(143);
  expect(groupSignals).toEqual([
    [-4_242, "SIGTERM"],
    [-4_242, "SIGKILL"],
  ]);
});
