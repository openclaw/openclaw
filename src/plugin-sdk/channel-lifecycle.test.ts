import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createAccountStatusSink,
  keepHttpServerTaskAlive,
  runPassiveAccountLifecycle,
  waitUntilAbort,
} from "./channel-lifecycle.core.js";
import { expectPendingUntilAbort } from "./test-helpers/start-account-lifecycle.js";

function expectOutcome(task: Promise<unknown>, failure?: Error) {
  return failure ? expect(task).rejects.toBe(failure) : expect(task).resolves.toBeUndefined();
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
    const patch = { running: true, lastStartAt: 123 };
    createAccountStatusSink({ accountId: "default", setStatus })(patch);
    expect(setStatus).toHaveBeenCalledWith({ ...patch, accountId: "default" });
  });

  it("rejects when abort cleanup throws", async () => {
    const abort = new AbortController();
    const failure = new Error("abort cleanup failed");
    const task = waitUntilAbort(abort.signal, () => {
      throw failure;
    });
    const settled = expect(task).rejects.toBe(failure);
    abort.abort();
    await settled;
  });

  it.each(["readiness", "assertion", "startup"] as const)(
    "joins account startup when its %s check fails",
    async (failurePhase) => {
      const startup = createDeferredCore<() => void>();
      const abort = new AbortController();
      let settled = false;
      const stop = vi.fn();
      const assertAfterAbort = vi.fn();
      const failure = new Error(`${failurePhase} failed`);
      const fail = () => {
        throw failure;
      };
      const task = runPassiveAccountLifecycle({
        abortSignal: abort.signal,
        start: failurePhase === "startup" ? async () => fail() : () => startup.promise,
        stop: (unregister) => unregister(),
      }).finally(() => {
        settled = true;
      });
      const accountOutcome = expectOutcome(task, failurePhase === "startup" ? failure : undefined);
      try {
        await expect(
          expectPendingUntilAbort({
            abort,
            task,
            isSettled: () => settled,
            waitForStarted: async () => {
              if (failurePhase === "startup") {
                return startup.promise.then(() => {});
              }
              startup.resolve(stop);
              if (failurePhase === "readiness") {
                throw failure;
              }
            },
            assertBeforeAbort: () => {
              expect(stop).not.toHaveBeenCalled();
              fail();
            },
            assertAfterAbort,
          }),
        ).rejects.toBe(failure);
        expect([abort.signal.aborted, settled]).toEqual([true, true]);
        expect(stop).toHaveBeenCalledTimes(failurePhase === "startup" ? 0 : 1);
        expect(assertAfterAbort).not.toHaveBeenCalled();
      } finally {
        startup.resolve(stop);
        abort.abort();
        await accountOutcome;
      }
    },
  );

  it.each(["close", "abort", "already-aborted", "throw", "reject"] as const)(
    "settles server lifecycle after %s",
    async (mode) => {
      const server = new EventEmitter();
      const close = () => server.emit("close");
      const abort = new AbortController();
      const failure = new Error("server cleanup failed");
      const onAbort = vi.fn(() => {
        if (mode === "abort") {
          queueMicrotask(close);
        } else {
          close();
        }
        if (mode === "throw") {
          throw failure;
        }
        if (mode === "reject") {
          return Promise.reject(failure);
        }
        return undefined;
      });
      const task = keepHttpServerTaskAlive({
        server,
        ...(mode === "close"
          ? {}
          : {
              abortSignal: mode === "abort" ? abort.signal : AbortSignal.abort(),
              onAbort,
            }),
      });
      if (mode === "close" || mode === "abort") {
        await expectTaskPending(task);
        if (mode === "abort") {
          abort.abort();
        } else {
          queueMicrotask(close);
        }
      }
      await expectOutcome(task, mode === "throw" || mode === "reject" ? failure : undefined);
      if (mode !== "close") {
        expect(onAbort).toHaveBeenCalledOnce();
      }
    },
  );
});
