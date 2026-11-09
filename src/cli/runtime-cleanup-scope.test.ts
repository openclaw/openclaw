import "../test-utils/prepare-compiled-subprocesses.js";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import * as postgres from "../infra/postgres-sync/pool.js";
import {
  captureRuntimeWorkerSource,
  withRuntimeWorkerGeneration,
} from "../infra/runtime-worker-generation.js";
import * as workers from "../infra/worker-native-lifecycle.js";
import * as database from "../state/openclaw-state-db-cache.js";
import * as lifecycle from "./gateway-cli/run-loop.test-support.js";
import { withCliCommandCleanup, withCliProcessScope } from "./runtime-cleanup-scope.js";
import { runCliDisposer, waitForPendingCliDisposers } from "./runtime-cleanup.js";

const closeDatabase = vi.spyOn(database, "closeOpenClawStateDatabaseAsync");
const closeWorkers = vi.spyOn(workers, "closeDefaultRetainedNativeWorkerSource");
const closePostgres = vi.spyOn(postgres, "closePostgresPool");
const events: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  events.length = 0;
  closeDatabase.mockReset().mockImplementation(async () => void events.push("database"));
  closeWorkers.mockReset().mockImplementation(async () => void events.push("workers"));
  closePostgres.mockReset().mockImplementation(async () => void events.push("postgres"));
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

it("keeps PostgreSQL services through generation settlement and native backend close", async () => {
  const settlement = lifecycle.createLifecycleGate();
  const backendClose = lifecycle.createLifecycleGate();
  const closing = runCommand(() =>
    withRuntimeWorkerGeneration(
      async (bind) => {
        bind(() => new URL("file:///synthetic/retained/worker.js"));
        const { runtimeGeneration } = captureRuntimeWorkerSource(
          new URL("file:///synthetic/original/worker.js"),
        );
        if (!runtimeGeneration) {
          throw new Error("Synthetic worker generation was not bound");
        }
        runtimeGeneration.retain({}, async () => {
          await settlement.wait();
          events.push("settled");
          return async () => {
            await backendClose.wait();
            events.push("backend-close");
          };
        });
      },
      async () => void events.push("released"),
    ),
  );
  try {
    await settlement.entered;
    expect(closePostgres).not.toHaveBeenCalled();
    settlement.release();
    await backendClose.entered;
    expect(closePostgres).not.toHaveBeenCalled();
    backendClose.release();
    await closing;
    expect(events).toEqual([
      "settled",
      "backend-close",
      "released",
      "database",
      "workers",
      "postgres",
    ]);
  } finally {
    settlement.release();
    backendClose.release();
    await closing;
  }
});

it.each(["database", "workers"] as const)(
  "retains PostgreSQL services and reports a rejected %s drain",
  async (stage) => {
    const failure = new Error(`${stage} drain failed`);
    const close = stage === "database" ? closeDatabase : closeWorkers;
    close.mockRejectedValueOnce(failure);

    await expect(runCommand(() => "command-result")).resolves.toBe("command-result");

    expect(closePostgres).not.toHaveBeenCalled();
    expect(closeWorkers).toHaveBeenCalledTimes(stage === "database" ? 0 : 1);
    expect(console.error).toHaveBeenCalledWith(
      `CLI cleanup failed: shared-state: ${failure.message}`,
    );
  },
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
    expect(events).toEqual([
      "write",
      "database",
      "workers",
      "postgres",
      "database",
      "workers",
      "postgres",
    ]);
  } finally {
    parent.release();
    write.release();
    await closing;
    await waitForPendingCliDisposers();
  }
});

it.each(["database", "workers", "postgres"] as const)("bounds %s cleanup", async (stage) => {
  const stalled = lifecycle.createLifecycleGate();
  const commandError = new Error("command failed");
  const completed = vi.fn();
  const close =
    stage === "database" ? closeDatabase : stage === "workers" ? closeWorkers : closePostgres;
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
  expect(closePostgres).toHaveBeenCalledOnce();
});
