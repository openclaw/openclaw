import { spawn } from "node:child_process";
import fsSync from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  waitForChildClose,
  waitForDead,
  waitForFile,
  waitForFixtureFile,
  waitForPidFile,
} from "./process-wait.js";
import { createDeferred, withinTest } from "./promise.js";
import { useAutoCleanupTempDirTracker } from "./temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
});

const fileWaits = [
  { name: "file", wait: waitForFile, expected: undefined },
  { name: "PID", wait: waitForPidFile, expected: 42 },
];

it.for(fileWaits)(
  "observes $name readiness on the next tick",
  async ({ wait, expected }, { signal }) => {
    const file = path.join(tempDirs.make("openclaw-process-wait-"), "ready");
    const waiting = wait(file, signal);
    fsSync.writeFileSync(file, "42\n");
    expect(await waiting).toBe(expected);
  },
);

it.for(fileWaits)(
  "rechecks $name readiness before rejecting abort",
  async ({ wait, expected }, { signal }) => {
    const file = path.join(tempDirs.make("openclaw-process-wait-"), "ready");
    const controller = new AbortController();
    const waiting = wait(file, AbortSignal.any([signal, controller.signal]));
    fsSync.writeFileSync(file, "42\n");
    controller.abort(new Error("test cancelled"));
    expect(await waiting).toBe(expected);
  },
);

it.for(fileWaits)("diagnoses missing $name on abort", async ({ wait }, { signal }) => {
  const file = path.join(tempDirs.make("openclaw-process-wait-"), "missing");
  const controller = new AbortController();
  const reason = new Error("test cancelled");
  const bounded = AbortSignal.any([signal, controller.signal]);
  const waiting = wait(file, bounded);
  const rejected = expect(waiting).rejects.toMatchObject({
    message: expect.stringContaining(file),
    cause: reason,
  });
  controller.abort(reason);
  await rejected;
  await expect(wait(file, bounded)).rejects.toMatchObject({
    message: expect.stringContaining(file),
    cause: reason,
  });
});

it.for(["", "0"])(
  "waits through invalid PID contents %j using the injected delay",
  async (contents, { signal }) => {
    const file = path.join(tempDirs.make("openclaw-process-wait-"), "pid");
    fsSync.writeFileSync(file, contents);
    const tick = createDeferred();
    const waiting = waitForPidFile(file, signal, () => tick.promise);
    fsSync.writeFileSync(file, "42\n");
    tick.resolve();
    expect(await waiting).toBe(42);
  },
);

it("aborts an injected delay without waiting for its completion", async ({ signal }) => {
  const file = path.join(tempDirs.make("openclaw-process-wait-"), "missing");
  const tick = createDeferred();
  const controller = new AbortController();
  const reason = new Error("test cancelled");
  const waiting = waitForPidFile(
    file,
    AbortSignal.any([signal, controller.signal]),
    () => tick.promise,
  );
  const rejected = expect(waiting).rejects.toMatchObject({
    message: expect.stringContaining(file),
    cause: reason,
  });
  controller.abort(reason);
  await rejected;
  tick.resolve();
});

it("diagnoses a live process on abort", async ({ signal }) => {
  const controller = new AbortController();
  const reason = new Error("test cancelled");
  const waiting = waitForDead(process.pid, AbortSignal.any([signal, controller.signal]));
  const rejected = expect(waiting).rejects.toMatchObject({
    message: `process still alive: ${process.pid}`,
    cause: reason,
  });
  controller.abort(reason);
  await rejected;
});

it("observes real process death and child close after registration", async ({
  signal,
  onTestFinished,
}) => {
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  onTestFinished(() => {
    child.kill("SIGKILL");
  });
  const closed = waitForChildClose(child, signal);
  if (child.pid === undefined) {
    throw new Error("child has no PID");
  }
  const dead = waitForDead(child.pid, signal);
  child.stdin.end();
  await expect(closed).resolves.toEqual({ code: 0, signal: null });
  await expect(dead).resolves.toBeUndefined();
  // Already-observed death must also win over an already-aborted signal.
  await expect(
    waitForDead(child.pid, AbortSignal.any([signal, AbortSignal.abort("cancelled")])),
  ).resolves.toBeUndefined();
});

it("diagnoses child close cancellation and releases its listener", async ({
  signal,
  onTestFinished,
}) => {
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  onTestFinished(() => {
    child.kill("SIGKILL");
  });
  const closed = waitForChildClose(child, signal);
  const controller = new AbortController();
  const reason = new Error("test cancelled");
  const waiting = waitForChildClose(child, AbortSignal.any([signal, controller.signal]));
  const rejected = expect(waiting).rejects.toMatchObject({
    message: expect.stringContaining(`child ${child.pid}`),
    cause: reason,
  });
  controller.abort(reason);
  await rejected;
  expect(child.listenerCount("close")).toBe(1);
  child.stdin.end();
  await closed;
  expect(child.listenerCount("close")).toBe(0);
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
