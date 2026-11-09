import { writeSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { requestSettledExitWatchdog, runCliWithExitFinalization } from "./one-shot-exit.js";
import { runCliDisposer, waitForPendingCliDisposers } from "./runtime-cleanup.js";

// Keep the cleanup and CLI owners real; intercept only the irreversible process effects.
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  writeSync: vi.fn(() => 0),
}));

const kill = vi.fn<typeof process.kill>(() => true);

let previousExitCode: typeof process.exitCode;
beforeEach(() => {
  previousExitCode = process.exitCode;
  process.exitCode = 0;
  vi.useFakeTimers();
  vi.mocked(writeSync).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  kill.mockClear();
  vi.spyOn(process, "kill").mockImplementation(kill);
  vi.spyOn(process, "removeAllListeners").mockReturnValue(process);
});
afterEach(async () => {
  await waitForPendingCliDisposers();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.exitCode = previousExitCode;
});

const failDisposer = () =>
  runCliDisposer("failed-resource", async () => {
    throw new Error("synthetic cleanup failure");
  });
const requestWatchdog = async () => {
  requestSettledExitWatchdog(20);
};
const onError = (error: unknown) => {
  throw error;
};
function expectNoWatchdogEffect() {
  expect(writeSync).not.toHaveBeenCalled();
  expect(kill).not.toHaveBeenCalled();
}

it.each(["run", "finalize"])(
  "does not report or terminate after a swallowed %s disposer failure",
  async (phase) => {
    await expect(
      runCliWithExitFinalization({
        run: async () => {
          await requestWatchdog();
          if (phase === "run") {
            await failDisposer();
          }
        },
        finalize: async () => {
          if (phase === "finalize") {
            await failDisposer();
          }
          // A later successful disposer must not erase this execution's failed outcome.
          await runCliDisposer("later-resource", async () => {});
        },
        onError,
      }),
    ).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(20);
    expect(console.error).toHaveBeenCalledWith(
      "CLI cleanup failed: failed-resource: synthetic cleanup failure",
    );
    expect(process.exitCode).toBe(0);
    expectNoWatchdogEffect();
  },
);

it("joins a disposer that rejects after its reporting grace without arming the watchdog", async () => {
  const gate = createDeferredCore();
  const entered = createDeferredCore();
  const finished = vi.fn();
  const running = runCliWithExitFinalization({
    run: async () => {
      await requestWatchdog();
      await runCliDisposer(
        "late-failure",
        async () => {
          entered.resolve();
          await gate.promise;
          throw new Error("late cleanup failure");
        },
        undefined,
        5,
      );
    },
    onError,
  }).then(finished);
  try {
    await entered.promise;
    await vi.advanceTimersByTimeAsync(25);
    expect(finished).not.toHaveBeenCalled();
    expectNoWatchdogEffect();
  } finally {
    gate.resolve();
    await running;
  }
  await vi.advanceTimersByTimeAsync(20);
  expect(finished).toHaveBeenCalledOnce();
  expect(process.exitCode).toBe(0);
  expectNoWatchdogEffect();
});

it("rechecks failed cleanup admitted after the CLI returned", async () => {
  await runCliWithExitFinalization({ run: requestWatchdog, onError });
  await failDisposer();
  await vi.advanceTimersByTimeAsync(20);
  expectNoWatchdogEffect();
});

it("does not use an old settled claim while a new disposer is pending", async () => {
  await runCliWithExitFinalization({ run: requestWatchdog, onError });
  const gate = createDeferredCore();
  const disposing = runCliDisposer("new-work", () => gate.promise);
  try {
    await vi.advanceTimersByTimeAsync(20);
    expectNoWatchdogEffect();
  } finally {
    gate.resolve();
    await disposing;
  }
});

it("does not let an earlier failure poison a later successful execution", async () => {
  await runCliWithExitFinalization({
    run: async () => {
      await requestWatchdog();
      await failDisposer();
    },
    onError,
  });
  await vi.advanceTimersByTimeAsync(20);
  expectNoWatchdogEffect();
  await runCliWithExitFinalization({ run: requestWatchdog, onError });
  await vi.advanceTimersByTimeAsync(20);
  expect(writeSync).toHaveBeenCalledOnce();
  expect(kill).toHaveBeenCalledTimes(process.platform === "win32" ? 0 : 1);
  expect(process.exitCode).toBe(0);
});

it.each([false, true])(
  "retires the prior timer before a new execution (embedded: %s)",
  async (embedded) => {
    await runCliWithExitFinalization({ run: requestWatchdog, onError });
    const gate = createDeferredCore();
    const running = runCliWithExitFinalization({
      run: () => gate.promise,
      onError,
      ...(embedded ? { runtime: { log() {}, error() {}, exit() {} } } : {}),
    });
    try {
      await vi.advanceTimersByTimeAsync(20);
      expectNoWatchdogEffect();
    } finally {
      gate.resolve();
      await running;
    }
  },
);

it("does not carry an embedded watchdog request into the next default execution", async () => {
  await runCliWithExitFinalization({
    run: requestWatchdog,
    runtime: { log() {}, error() {}, exit() {} },
    onError,
  });
  await runCliWithExitFinalization({ run: async () => {}, onError });
  await vi.advanceTimersByTimeAsync(20);
  expectNoWatchdogEffect();
});

it("preserves the existing finalizer failure status without a settled diagnostic", async () => {
  const report = vi.fn();
  await runCliWithExitFinalization({
    run: requestWatchdog,
    finalize: async () => {
      throw new Error("finalizer failure");
    },
    onError: report,
  });
  await vi.advanceTimersByTimeAsync(20);
  expect(report).toHaveBeenCalledOnce();
  expect(process.exitCode).toBe(1);
  expectNoWatchdogEffect();
});
