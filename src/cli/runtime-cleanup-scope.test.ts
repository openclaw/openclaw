import "../test-utils/prepare-compiled-subprocesses.js";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import * as workers from "../infra/worker-native-lifecycle.js";
import * as database from "../state/openclaw-state-db-cache.js";
import * as lifecycle from "./gateway-cli/run-loop.test-support.js";
import { withCliCommandCleanup, withCliProcessScope } from "./runtime-cleanup-scope.js";
import { runCliDisposer, waitForPendingCliDisposers } from "./runtime-cleanup.js";

const closeDatabase = vi.spyOn(database, "closeOpenClawStateDatabaseAsync");
const closeWorkers = vi.spyOn(workers, "closeDefaultRetainedNativeWorkerSource");
const events: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  events.length = 0;
  closeDatabase.mockReset().mockImplementation(async () => void events.push("database"));
  closeWorkers.mockReset().mockImplementation(async () => void events.push("workers"));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.mocked(console.error).mockRestore();
});
afterAll(() => vi.restoreAllMocks());

const runCommand = <T>(run: () => T | Promise<T>) =>
  withCliProcessScope(() =>
    withCliCommandCleanup(false, async (cleanup) => {
      await cleanup?.pluginResources?.release();
      return run();
    }),
  );

it("defers shared-state closure until expired disposal and its late write settle", async () => {
  const parent = lifecycle.createLifecycleGate();
  const write = lifecycle.createLifecycleGate();
  const completed = vi.fn();
  const closing = runCommand(async () => {
    await runCliDisposer("plugin-parent", async () => {
      await parent.wait();
      await runCliDisposer("plugin-write", async () => {
        await write.wait();
        events.push("write");
      });
    });
    return "command-result";
  }).then(completed);
  try {
    await parent.entered;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(completed).toHaveBeenCalledWith("command-result");
    expect(console.error).toHaveBeenCalledWith(
      "CLI cleanup deferred: shared-state until pending disposers settle: plugin-parent",
    );
    // A subsequent command's drain must follow the first without waiting on itself.
    await runCommand(() => {});
    parent.release();
    await write.entered;
    await lifecycle.advanceWithoutCalls(5_000, closeDatabase);
    write.release();
    await waitForPendingCliDisposers();
    expect(events).toEqual(["write", "database", "workers", "database", "workers"]);
  } finally {
    parent.release();
    write.release();
    await closing;
    await waitForPendingCliDisposers();
  }
});

it.each(["database", "workers"] as const)("bounds %s cleanup", async (stage) => {
  const stalled = lifecycle.createLifecycleGate();
  const commandError = new Error("command failed");
  const completed = vi.fn();
  const close = stage === "database" ? closeDatabase : closeWorkers;
  close.mockImplementationOnce(stalled.wait);
  const closing = runCommand(() => {
    if (stage === "database") {
      throw commandError;
    }
    return "command-result";
  }).then(completed, completed);
  try {
    await stalled.entered;
    await lifecycle.advanceWithoutCalls(4_999, completed);
    await vi.advanceTimersByTimeAsync(1);
    expect(completed).toHaveBeenCalledWith(stage === "database" ? commandError : "command-result");
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      "CLI cleanup timed out: shared-state after 5000ms",
    );
    expect(closeWorkers).toHaveBeenCalledTimes(stage === "database" ? 0 : 1);
  } finally {
    stalled.release();
    await closing;
    await waitForPendingCliDisposers();
  }
  expect(closeWorkers).toHaveBeenCalledOnce();
});
