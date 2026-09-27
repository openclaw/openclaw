/**
 * Tests channel lifecycle hooks and SDK-visible lifecycle dispatch behavior.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
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

type FakeServer = EventEmitter & {
  close: (callback?: () => void) => void;
};

function createFakeServer(): FakeServer {
  const server = new EventEmitter() as FakeServer;
  server.close = (callback) => {
    queueMicrotask(() => {
      server.emit("close");
      callback?.();
    });
  };
  return server;
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
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("binds account id onto status patches", () => {
    const setStatus = vi.fn();
    const statusSink = createAccountStatusSink({
      accountId: "default",
      setStatus,
    });

    statusSink({ running: true, lastStartAt: 123 });

    expect(setStatus).toHaveBeenCalledWith({
      accountId: "default",
      running: true,
      lastStartAt: 123,
    });
  });

  it("resolves waitUntilAbort when signal aborts", async () => {
    const abort = new AbortController();
    const task = waitUntilAbort(abort.signal);
    await expectTaskPending(task);

    abort.abort();
    await expect(task).resolves.toBeUndefined();
  });

  it("runs abort cleanup before resolving", async () => {
    const abort = new AbortController();
    const onAbort = vi.fn(async () => undefined);

    const task = waitUntilAbort(abort.signal, onAbort);
    abort.abort();

    await expect(task).resolves.toBeUndefined();
    expect(onAbort).toHaveBeenCalledOnce();
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

  it.each(["readiness", "assertion"] as const)(
    "joins account startup when its %s check fails",
    async (failurePhase) => {
      const startup = createDeferredCore<() => void>();
      const stop = vi.fn();
      const failure = new Error(`${failurePhase} failed`);
      const { abort, task, isSettled } = startAccountAndTrackLifecycle({
        account: { accountId: "default" },
        startAccount: ({ abortSignal }) =>
          runPassiveAccountLifecycle({
            abortSignal,
            start: () => startup.promise,
            stop: (unregister) => unregister(),
          }),
      });
      try {
        await expect(
          expectPendingUntilAbort({
            abort,
            task,
            isSettled,
            waitForStarted: async () => {
              startup.resolve(stop);
              if (failurePhase === "readiness") {
                throw failure;
              }
            },
            assertBeforeAbort: () => {
              throw failure;
            },
          }),
        ).rejects.toBe(failure);
        expect(abort.signal.aborted).toBe(true);
        expect(stop).toHaveBeenCalledOnce();
        expect(isSettled()).toBe(true);
      } finally {
        startup.resolve(stop);
        abort.abort();
        await task;
      }
    },
  );

  it("reports startup rejection before readiness and joins the failed account", async () => {
    const readiness = createDeferredCore();
    const failure = new Error("account startup failed");
    const assertAfterAbort = vi.fn();
    const { abort, task, isSettled } = startAccountAndTrackLifecycle({
      account: { accountId: "default" },
      startAccount: ({ abortSignal }) =>
        runPassiveAccountLifecycle({
          abortSignal,
          start: async () => {
            throw failure;
          },
        }),
    });
    const accountRejection = expect(task).rejects.toBe(failure);
    const check = expectPendingUntilAbort({
      abort,
      task,
      isSettled,
      waitForStarted: () => readiness.promise,
      assertAfterAbort,
    });
    const checkRejection = expect(check).rejects.toBe(failure);
    onTestFinished(async () => {
      readiness.resolve();
      await accountRejection;
      await checkRejection;
    });
    await checkRejection;
    await accountRejection;
    expect(abort.signal.aborted).toBe(true);
    expect(isSettled()).toBe(true);
    expect(assertAfterAbort).not.toHaveBeenCalled();
  });

  it("keeps server task pending until close, then resolves", async () => {
    const server = createFakeServer();
    const task = keepHttpServerTaskAlive({ server });
    await expectTaskPending(task);

    server.close();
    await expect(task).resolves.toBeUndefined();
  });

  it("triggers abort hook once and resolves after close", async () => {
    const server = createFakeServer();
    const abort = new AbortController();
    const onAbort = vi.fn(async () => {
      server.close();
    });

    const task = keepHttpServerTaskAlive({
      server,
      abortSignal: abort.signal,
      onAbort,
    });

    abort.abort();
    await expect(task).resolves.toBeUndefined();
    expect(onAbort).toHaveBeenCalledOnce();
  });
});
