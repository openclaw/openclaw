import { spawn } from "node:child_process";
import { once } from "node:events";
import fsSync from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { waitForDead, waitForFile, waitForFixtureFile, waitForPidFile } from "./process-wait.js";
import { createDeferred, withinTest } from "./promise.js";
import { useAutoCleanupTempDirTracker } from "./temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fixturePath = () => path.join(tempDirs.make("openclaw-process-wait-"), "ready");
function cancellation(signal: AbortSignal) {
  const controller = new AbortController();
  const reason = new Error("test cancelled");
  return {
    signal: AbortSignal.any([signal, controller.signal]),
    reason,
    abort: () => controller.abort(reason),
  };
}
const fileError = (file: string, cause: Error) => ({
  message: expect.stringContaining(file),
  cause,
});

afterEach(() => {
  vi.restoreAllMocks();
});

const fileWaits = [
  { name: "file", wait: waitForFile, expected: undefined },
  { name: "PID", wait: waitForPidFile, expected: 42 },
];

it.for(fileWaits)(
  "rechecks $name readiness before rejecting abort",
  async ({ wait, expected }, { signal }) => {
    const file = fixturePath();
    const cancelled = cancellation(signal);
    const waiting = wait(file, cancelled.signal);
    fsSync.writeFileSync(file, "42\n");
    cancelled.abort();
    expect(await waiting).toBe(expected);
  },
);

it.for(["file", "PID", "injected delay", "live process"] as const)(
  "diagnoses %s on abort without waiting for an injected delay",
  async (kind, { signal }) => {
    const file = fixturePath();
    const cancelled = cancellation(signal);
    const tick = createDeferred();
    const wait = () =>
      kind === "live process"
        ? waitForDead(process.pid, cancelled.signal)
        : kind === "file"
          ? waitForFile(file, cancelled.signal)
          : waitForPidFile(
              file,
              cancelled.signal,
              kind === "injected delay" ? () => tick.promise : undefined,
            );
    const diagnostic =
      kind === "live process"
        ? { message: `process still alive: ${process.pid}`, cause: cancelled.reason }
        : fileError(file, cancelled.reason);
    const rejected = expect(wait()).rejects.toMatchObject(diagnostic);
    cancelled.abort();
    await rejected;
    if (kind === "file" || kind === "PID") {
      await expect(wait()).rejects.toMatchObject(diagnostic);
    }
    tick.resolve();
  },
);

it("waits through empty PID contents using the injected delay", async ({ signal }) => {
  const file = fixturePath();
  fsSync.writeFileSync(file, "");
  const tick = createDeferred();
  const waiting = waitForPidFile(file, signal, () => tick.promise);
  fsSync.writeFileSync(file, "42\n");
  tick.resolve();
  expect(await waiting).toBe(42);
});

it("observes real process death before and after abort", async ({ signal, onTestFinished }) => {
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  onTestFinished(() => {
    child.kill("SIGKILL");
  });
  const closed = once(child, "close", { signal });
  if (child.pid === undefined) {
    throw new Error("child has no PID");
  }
  const dead = waitForDead(child.pid, signal);
  child.stdin.end();
  await expect(closed).resolves.toEqual([0, null]);
  await expect(dead).resolves.toBeUndefined();
  // Already-observed death must also win over an already-aborted signal.
  await expect(
    waitForDead(child.pid, AbortSignal.any([signal, AbortSignal.abort("cancelled")])),
  ).resolves.toBeUndefined();
});

it("rejects an abort event without rechecking an unobserved process exit", async ({ signal }) => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(fsSync, "readFileSync").mockReturnValue("State:\tS (sleeping)\nThreads:\t1\n");
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  const cancelled = cancellation(signal);
  const remove = vi.spyOn(cancelled.signal, "removeEventListener");
  const waiting = waitForDead(42, cancelled.signal, "reject");
  const rejected = expect(waiting).rejects.toMatchObject({
    message: "process still alive: 42",
    cause: cancelled.reason,
  });
  kill.mockImplementation(() => {
    throw Object.assign(new Error("process missing"), { code: "ESRCH" });
  });
  cancelled.abort();
  await rejected;
  expect(kill).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledTimes(1);
  // Initial observation still wins for an already-dead PID and aborted signal.
  await expect(waitForDead(42, cancelled.signal, "reject")).resolves.toBeUndefined();
});

it("stops waiting when a Linux process is a zombie", async ({ signal }) => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(process, "kill").mockImplementation(() => true);
  vi.spyOn(fsSync, "readFileSync").mockImplementation((filePath) => {
    if (String(filePath) === "/proc/42/status") {
      return "Name:\tworker\nState:\tZ (zombie)\nPid:\t42\nThreads:\t1\n";
    }
    throw new Error(`unexpected read: ${String(filePath)}`);
  });

  await expect(waitForDead(42, signal)).resolves.toBeUndefined();
});

it.for(["borrower completion", "persistent file"] as const)(
  "observes readiness from %s without a file-watch event",
  async (observation, { signal }) => {
    const filename = path.join(tempDirs.make("openclaw-process-receipt-"), "ready");
    const { promise: completion, resolve: finish } = createDeferred();
    const watchFile = fsSync.watchFile;
    // A successful initial stat establishes a baseline without notifying Node's
    // watchFile listener. A receipt created during that stat must still be seen.
    const watcher = vi
      .spyOn(fsSync, "watchFile")
      .mockImplementation((target, ...args) =>
        target === filename
          ? watchFile(filename, { interval: 50 }, () => {})
          : watchFile(target, ...args),
      );
    let ready = false;
    const waiting = waitForFixtureFile(filename, completion).then(() => {
      ready = true;
    });
    try {
      fsSync.writeFileSync(filename, "ready");
      if (observation === "borrower completion") {
        finish();
        await nextTurn();
        expect(ready).toBe(true);
      }
      await withinTest(waiting, signal);
      expect(ready).toBe(true);
    } finally {
      finish();
      await waiting.finally(() => {
        fsSync.unwatchFile(filename);
        watcher.mockRestore();
      });
    }
  },
);
