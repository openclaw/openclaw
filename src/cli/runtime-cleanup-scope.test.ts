import "../test-utils/prepare-compiled-subprocesses.js";
import "../infra/worker-native-lifecycle.js";
import "../state/openclaw-state-db-cache.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { withCliCommandCleanup, withCliProcessScope } from "./runtime-cleanup-scope.js";
import { runCliDisposer, waitForPendingCliDisposers } from "./runtime-cleanup.js";

const { closeDatabase, closeWorkers } = vi.hoisted(() => ({
  closeDatabase: vi.fn<() => Promise<void>>(),
  closeWorkers: vi.fn<() => Promise<void>>(),
}));
const events: string[] = [];

vi.mock("../state/openclaw-state-db-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/openclaw-state-db-cache.js")>()),
  closeOpenClawStateDatabaseAsync: closeDatabase,
}));
vi.mock("../infra/worker-native-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/worker-native-lifecycle.js")>()),
  closeDefaultRetainedNativeWorkerSource: closeWorkers,
}));

beforeEach(() => {
  vi.useFakeTimers();
  events.length = 0;
  closeDatabase.mockReset().mockImplementation(async () => void events.push("database"));
  closeWorkers.mockReset().mockImplementation(async () => void events.push("workers"));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const runCommand = <T>(run: () => T | Promise<T>) =>
  withCliProcessScope(() =>
    withCliCommandCleanup(false, async (cleanup) => {
      await cleanup?.pluginResources?.release();
      return run();
    }),
  );

it("defers shared-state closure until expired disposal and its late write settle", async () => {
  const parentEntered = createDeferredCore();
  const releaseParent = createDeferredCore();
  const childEntered = createDeferredCore();
  const releaseWrite = createDeferredCore();
  const completed = vi.fn();
  const closing = runCommand(async () => {
    await runCliDisposer("plugin-parent", async () => {
      parentEntered.resolve();
      await releaseParent.promise;
      await runCliDisposer("plugin-write", async () => {
        childEntered.resolve();
        await releaseWrite.promise;
        events.push("write");
      });
    });
    return "command-result";
  }).then(completed);
  try {
    await parentEntered.promise;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(completed).toHaveBeenCalledWith("command-result");
    expect(console.error).toHaveBeenCalledWith(
      "CLI cleanup deferred: shared-state until pending disposers settle: plugin-parent",
    );
    // A subsequent command's drain must follow the first without waiting on itself.
    await runCommand(() => {});
    releaseParent.resolve();
    await childEntered.promise;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(closeDatabase).not.toHaveBeenCalled();
    releaseWrite.resolve();
    await waitForPendingCliDisposers();
    expect(events).toEqual(["write", "database", "workers", "database", "workers"]);
  } finally {
    releaseParent.resolve();
    releaseWrite.resolve();
    await closing;
    await waitForPendingCliDisposers();
  }
});

it.each(["database", "workers"] as const)("bounds %s cleanup", async (stage) => {
  const entered = createDeferredCore();
  const stalled = createDeferredCore();
  const commandError = new Error("command failed");
  const completed = vi.fn();
  const close = stage === "database" ? closeDatabase : closeWorkers;
  close.mockImplementationOnce(() => {
    entered.resolve();
    return stalled.promise;
  });
  const closing = runCommand(() => {
    if (stage === "database") {
      throw commandError;
    }
    return "command-result";
  }).then(completed, completed);
  try {
    await entered.promise;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(completed).toHaveBeenCalledWith(stage === "database" ? commandError : "command-result");
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      "CLI cleanup timed out: shared-state after 5000ms",
    );
    if (stage === "database") {
      expect(closeWorkers).not.toHaveBeenCalled();
    }
  } finally {
    stalled.resolve();
    await closing;
    await waitForPendingCliDisposers();
  }
  expect(closeWorkers).toHaveBeenCalledOnce();
});
