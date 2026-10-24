import assert from "node:assert/strict";
import { createRetainedOperation, mapRetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type {
  PreparedSqliteReadOnlyLocation,
  RetainedPreparedSqliteReadOnlyLocation,
} from "./sqlite-readonly-location.types.js";
import {
  prepareSingleFlightSqliteSnapshot,
  startSingleFlightSqliteSnapshot,
} from "./sqlite-snapshot-single-flight.js";

function createSnapshot(
  location: string,
  cleanup: () => boolean = () => true,
  cleanupAsync = async () => cleanup(),
): PreparedSqliteReadOnlyLocation {
  return { location, cleanup, cleanupAsync };
}

function completed<T>(value: T) {
  const retained = createRetainedOperation<T>(() => {});
  retained.resolve(value);
  return retained.operation;
}

it("does not replay a synchronously refused producer even if a second attempt could succeed", () => {
  const failure = new Error("snapshot producer admission refused");
  let attempts = 0;
  const pending = startSingleFlightSqliteSnapshot(
    "refused-producer.sqlite",
    "retained-test",
    () => {
      attempts++;
      if (attempts === 1) {
        throw failure;
      }
      return {
        ...completed<PreparedSqliteReadOnlyLocation & RetainedPreparedSqliteReadOnlyLocation>({
          ...createSnapshot("untracked-second-snapshot.sqlite"),
          startCleanup: () => completed(true),
        }),
        startClose: () => completed(undefined),
      };
    },
  );
  pending.service();
  expect(pending.read()).toEqual({ status: "rejected", error: failure });
  expect(attempts).toBe(1);
});

it("services shared production and final cleanup without a host microtask turn", () => {
  const production = createRetainedOperation<
    PreparedSqliteReadOnlyLocation & RetainedPreparedSqliteReadOnlyLocation
  >(() => {});
  const removal = createRetainedOperation<boolean>(() => {});
  const producer = {
    ...production.operation,
    startClose: () =>
      mapRetainedOperation(removal.operation, (cleaned) => {
        expect(cleaned).toBe(true);
      }),
  };
  const controller = new AbortController();
  const reason = new Error("one retained waiter stopped");
  const start = (signal?: AbortSignal) =>
    startSingleFlightSqliteSnapshot(
      "retained-progress.sqlite",
      "retained-test",
      () => producer,
      signal,
    );
  const cancelled = start(controller.signal);
  const surviving = start();
  controller.abort(reason);
  expect(cancelled.read()).toEqual({ status: "rejected", error: reason });
  expect(surviving.read()).toEqual({ status: "pending" });
  production.resolve({
    location: "retained-snapshot.sqlite",
    cleanup() {
      throw new Error("A retained lease cannot substitute synchronous native cleanup");
    },
    cleanupAsync() {
      throw new Error("A retained lease cannot depend on a Promise-only cleanup path");
    },
    startCleanup: () => removal.operation,
  });
  surviving.service();
  const ready = surviving.read();
  assert(ready.status === "fulfilled", "The retained snapshot did not become available");
  const cleanup = ready.value.startCleanup();
  cleanup.service();
  expect(cleanup.read()).toEqual({ status: "pending" });
  removal.resolve(true);
  cleanup.service();
  expect(cleanup.read()).toEqual({ status: "fulfilled", value: true });
});

it.each(["all", 0, 1] as const)(
  "withdraws only cancelled snapshot demand: %s",
  async (cancelled) => {
    let copies = 0;
    let removed = false;
    const controllers = [new AbortController(), new AbortController()];
    const operations = controllers.map((controller) =>
      prepareSingleFlightSqliteSnapshot(
        `surviving-demand-${cancelled}.sqlite`,
        "test",
        async (signal) => {
          signal.throwIfAborted();
          copies += 1;
          return createSnapshot("surviving-snapshot.sqlite", () => (removed = true));
        },
        controller.signal,
      ),
    );
    if (cancelled === "all") {
      for (const controller of controllers) {
        controller.abort(new Error("cancelled before admission"));
      }
      expect(await Promise.allSettled(operations)).toEqual(
        controllers.map((controller) => ({ status: "rejected", reason: controller.signal.reason })),
      );
      expect(copies).toBe(0);
      return;
    }
    controllers[cancelled]!.abort(new Error("one waiter cancelled"));
    await expect(operations[cancelled]).rejects.toBe(controllers[cancelled]!.signal.reason);
    const snapshot = await operations[1 - cancelled]!;
    expect({ copies, removed }).toEqual({ copies: 1, removed: false });
    expect(await snapshot.cleanupAsync()).toBe(true);
    expect(removed).toBe(true);
  },
);

it("joins orphan cleanup before cancellation settles", async () => {
  const admitted = createDeferred();
  const produced = createDeferred();
  const cleanupStarted = createDeferred();
  const cleanupFinished = createDeferred();
  const controller = new AbortController();
  const pending = prepareSingleFlightSqliteSnapshot(
    "orphan-drain.sqlite",
    "test",
    async () => {
      admitted.resolve();
      await produced.promise;
      return createSnapshot(
        "orphan-snapshot.sqlite",
        () => true,
        async () => {
          cleanupStarted.resolve();
          await cleanupFinished.promise;
          return true;
        },
      );
    },
    controller.signal,
  );
  await admitted.promise;
  controller.abort(new Error("caller cancelled"));
  const rejected = expect(pending).rejects.toThrow("caller cancelled");
  let settled = false;
  void pending.catch(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  produced.resolve();
  await cleanupStarted.promise;
  await Promise.resolve();
  await Promise.resolve();
  const settledBeforeCleanup = settled;
  cleanupFinished.resolve();
  await rejected;
  expect(settledBeforeCleanup).toBe(false);
});

it("retains the snapshot until a signalled joined waiter acquires its lease", async () => {
  const produced = createDeferred();
  let exists = true;
  let copies = 0;
  const family = { root: "/retained", main: "1:2:3:4:5:6", wal: "1:7:8:9:10:11" };
  const producer = async () => {
    copies += 1;
    await produced.promise;
    return {
      ...createSnapshot("joined-snapshot.sqlite", () => {
        exists = false;
        return true;
      }),
      privateFamily: family,
    };
  };
  const first = prepareSingleFlightSqliteSnapshot("joined-source.sqlite", "test", producer);
  await Promise.resolve();
  await Promise.resolve();
  const second = prepareSingleFlightSqliteSnapshot(
    "joined-source.sqlite",
    "test",
    producer,
    new AbortController().signal,
  );
  const firstCleanup = first.then((snapshot) => {
    expect(snapshot.privateFamily).toBe(family);
    return snapshot.cleanup();
  });
  produced.resolve();
  const snapshot = await second;
  try {
    expect(await firstCleanup).toBe(true);
    expect({ copies, exists }).toEqual({ copies: 1, exists: true });
    expect(snapshot.privateFamily).toBe(family);
  } finally {
    await snapshot.cleanupAsync();
  }
  expect(exists).toBe(false);
});
