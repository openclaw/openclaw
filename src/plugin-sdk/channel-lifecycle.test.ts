import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createAccountStatusSink,
  keepHttpServerTaskAlive,
  runPassiveAccountLifecycle,
  waitUntilAbort,
} from "./channel-lifecycle.core.js";
import {
  expectPendingUntilAbort,
  startAccountAndTrackLifecycle,
} from "./test-helpers/start-account-lifecycle.js";

class FakeServer extends EventEmitter {
  close(callback?: () => void) {
    queueMicrotask(() => {
      this.emit("close");
      callback?.();
    });
  }
}

function startPassiveAccount<Handle>(
  start: () => Promise<Handle>,
  stop?: (handle: Handle) => void,
) {
  return startAccountAndTrackLifecycle({
    account: { accountId: "default" },
    startAccount: ({ abortSignal }) => runPassiveAccountLifecycle({ abortSignal, start, stop }),
  });
}

async function expectTaskPending(task: Promise<unknown>) {
  let settled = false;
  void task.finally(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
}

describe("plugin-sdk channel lifecycle helpers", () => {
  it("binds account id onto status patches", () => {
    const setStatus = vi.fn();
    const statusSink = createAccountStatusSink({ accountId: "default", setStatus });
    statusSink({ running: true, lastStartAt: 123 });

    expect(setStatus).toHaveBeenCalledWith({
      accountId: "default",
      running: true,
      lastStartAt: 123,
    });
  });

  it.each(["none", "success", "throw"] as const)("settles abort cleanup: %s", async (outcome) => {
    const abort = new AbortController();
    const failure = new Error("abort cleanup failed");
    const onAbort = vi.fn(() => {
      if (outcome === "throw") {
        throw failure;
      }
      return Promise.resolve();
    });
    const task = waitUntilAbort(abort.signal, outcome === "none" ? undefined : onAbort);
    if (outcome === "none") {
      await expectTaskPending(task);
    }
    const settled =
      outcome === "throw"
        ? expect(task).rejects.toBe(failure)
        : expect(task).resolves.toBeUndefined();
    abort.abort();
    await settled;
    if (outcome !== "none") {
      expect(onAbort).toHaveBeenCalledOnce();
    }
  });

  it("keeps passive account lifecycle pending until abort, then stops once", async () => {
    const abort = new AbortController();
    const stop = vi.fn();
    const task = runPassiveAccountLifecycle({
      abortSignal: abort.signal,
      start: async () => ({ stop }),
      stop: async (handle) => {
        handle.stop();
      },
    });

    await expectTaskPending(task);
    expect(stop).not.toHaveBeenCalled();

    abort.abort();
    await expect(task).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledOnce();
  });

  it.each(["readiness", "assertion", "startup"] as const)(
    "joins account startup when its %s check fails",
    async (failurePhase) => {
      const startup = createDeferredCore<() => void>();
      const readiness = createDeferredCore();
      const stop = vi.fn();
      const assertAfterAbort = vi.fn();
      const failure = new Error(`${failurePhase} failed`);
      const { abort, task, isSettled } = startPassiveAccount(
        async () => {
          if (failurePhase === "startup") {
            throw failure;
          }
          return startup.promise;
        },
        (unregister) => unregister(),
      );
      const accountOutcome =
        failurePhase === "startup"
          ? expect(task).rejects.toBe(failure)
          : expect(task).resolves.toBeUndefined();
      try {
        await expect(
          expectPendingUntilAbort({
            abort,
            task,
            isSettled,
            waitForStarted: async () => {
              if (failurePhase === "startup") {
                return readiness.promise;
              }
              startup.resolve(stop);
              if (failurePhase === "readiness") {
                throw failure;
              }
            },
            assertBeforeAbort: () => {
              throw failure;
            },
            assertAfterAbort,
          }),
        ).rejects.toBe(failure);
        expect({ aborted: abort.signal.aborted, settled: isSettled() }).toEqual({
          aborted: true,
          settled: true,
        });
        expect(stop).toHaveBeenCalledTimes(failurePhase === "startup" ? 0 : 1);
        expect(assertAfterAbort).not.toHaveBeenCalled();
      } finally {
        startup.resolve(stop);
        readiness.resolve();
        abort.abort();
        await accountOutcome;
      }
    },
  );

  it.each([false, true])("keeps server task pending until close (abort=%s)", async (useAbort) => {
    const server = new FakeServer();
    const abort = new AbortController();
    const onAbort = vi.fn(async () => {
      server.close();
    });
    const task = keepHttpServerTaskAlive({
      server,
      ...(useAbort ? { abortSignal: abort.signal, onAbort } : {}),
    });
    await expectTaskPending(task);
    if (useAbort) {
      abort.abort();
    } else {
      server.close();
    }
    await expect(task).resolves.toBeUndefined();
    if (useAbort) {
      expect(onAbort).toHaveBeenCalledOnce();
    }
  });

  it.each(["success", "throw", "reject"] as const)(
    "observes synchronous close during already-aborted cleanup: %s",
    async (outcome) => {
      const server = new EventEmitter();
      const failure = new Error("server cleanup failed");
      const task = keepHttpServerTaskAlive({
        server,
        abortSignal: AbortSignal.abort(),
        onAbort: () => {
          server.emit("close");
          if (outcome === "throw") {
            throw failure;
          }
          if (outcome === "reject") {
            return Promise.reject(failure);
          }
          return undefined;
        },
      });

      if (outcome === "success") {
        await expect(task).resolves.toBeUndefined();
      } else {
        await expect(task).rejects.toBe(failure);
      }
    },
  );
});
