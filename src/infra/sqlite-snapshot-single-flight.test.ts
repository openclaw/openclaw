import { expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createRetainedOperation,
  flatMapRetainedOperation,
  mapRetainedOperation,
} from "./retained-operation.js";
import type {
  PreparedSqliteReadOnlyLocation,
  RetainedPreparedSqliteReadOnlyLocation,
} from "./sqlite-readonly-location.types.js";
import {
  prepareSingleFlightSqliteSnapshot,
  startSingleFlightSqliteSnapshot,
} from "./sqlite-snapshot-single-flight.js";

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
      const unexpected = createRetainedOperation<
        PreparedSqliteReadOnlyLocation & RetainedPreparedSqliteReadOnlyLocation
      >(() => {});
      unexpected.resolve({
        location: "untracked-second-snapshot.sqlite",
        cleanup: () => true,
        cleanupAsync: async () => true,
        startCleanup() {
          const cleanup = createRetainedOperation<boolean>(() => {});
          cleanup.resolve(true);
          return cleanup.operation;
        },
      });
      return {
        ...unexpected.operation,
        startClose: () =>
          flatMapRetainedOperation(unexpected.operation, (prepared) =>
            mapRetainedOperation(prepared.startCleanup(), (cleaned) => {
              if (!cleaned) {
                throw new Error("Unexpected snapshot cleanup failed");
              }
            }),
          ),
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
        if (!cleaned) {
          throw new Error("Retained producer cleanup failed");
        }
      }),
  };
  const controller = new AbortController();
  const reason = new Error("one retained waiter stopped");
  const cancelled = startSingleFlightSqliteSnapshot(
    "retained-progress.sqlite",
    "retained-test",
    () => producer,
    controller.signal,
  );
  const surviving = startSingleFlightSqliteSnapshot(
    "retained-progress.sqlite",
    "retained-test",
    () => producer,
  );
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
  expect(ready.status).toBe("fulfilled");
  if (ready.status !== "fulfilled") {
    throw new Error("The retained snapshot did not become available");
  }
  const cleanup = ready.value.startCleanup();
  cleanup.service();
  expect(cleanup.read()).toEqual({ status: "pending" });
  removal.resolve(true);
  cleanup.service();
  expect(cleanup.read()).toEqual({ status: "fulfilled", value: true });
});

it("withdraws all cancelled waiters before admitting snapshot work", async () => {
  let copies = 0;
  const controllers = [new AbortController(), new AbortController()];
  const operations = controllers.map((controller) =>
    prepareSingleFlightSqliteSnapshot(
      "cancelled-demand.sqlite",
      "test",
      async (signal) => {
        signal.throwIfAborted();
        copies += 1;
        return {
          location: "cancelled-snapshot.sqlite",
          cleanup: () => true,
          cleanupAsync: async () => true,
        };
      },
      controller.signal,
    ),
  );
  for (const controller of controllers) {
    controller.abort(new Error("cancelled before admission"));
  }
  const results = await Promise.allSettled(operations);
  expect(results).toEqual(
    controllers.map((controller) => ({
      status: "rejected",
      reason: controller.signal.reason,
    })),
  );
  expect(copies).toBe(0);
});

it.each([0, 1])("keeps shared snapshot demand when waiter %i cancels", async (cancelled) => {
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
        return {
          location: "surviving-snapshot.sqlite",
          cleanup: () => {
            removed = true;
            return true;
          },
          cleanupAsync: async () => {
            removed = true;
            return true;
          },
        };
      },
      controller.signal,
    ),
  );
  controllers[cancelled]!.abort(new Error("one waiter cancelled"));
  await expect(operations[cancelled]).rejects.toBe(controllers[cancelled]!.signal.reason);
  const snapshot = await operations[1 - cancelled]!;
  expect(copies).toBe(1);
  expect(removed).toBe(false);
  expect(await snapshot.cleanupAsync()).toBe(true);
  expect(removed).toBe(true);
});

it("joins orphan cleanup before the tracked producer settles", async () => {
  const admitted = createDeferred();
  const produced = createDeferred();
  const cleanupStarted = createDeferred();
  const cleanupFinished = createDeferred();
  const tracked: Promise<unknown>[] = [];
  const controller = new AbortController();
  const pending = prepareSingleFlightSqliteSnapshot(
    "orphan-drain.sqlite",
    "test",
    async () => {
      admitted.resolve();
      await produced.promise;
      return {
        location: "orphan-snapshot.sqlite",
        cleanup: () => true,
        cleanupAsync: async () => {
          cleanupStarted.resolve();
          await cleanupFinished.promise;
          return true;
        },
      };
    },
    controller.signal,
    { trackProducer: (producer) => tracked.push(producer) },
  );
  await admitted.promise;
  controller.abort(new Error("caller cancelled"));
  await expect(pending).rejects.toThrow("caller cancelled");
  expect(tracked).toHaveLength(1);
  let settled = false;
  void tracked[0]?.then(() => {
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
  await expect(tracked[0]).resolves.toMatchObject({ location: "orphan-snapshot.sqlite" });
  expect(settledBeforeCleanup).toBe(false);
});

it("retains the snapshot until a signalled joined waiter acquires its lease", async () => {
  const produced = createDeferred();
  let exists = true;
  let copies = 0;
  const producer = async () => {
    copies += 1;
    await produced.promise;
    return {
      location: "joined-snapshot.sqlite",
      cleanup: () => {
        exists = false;
        return true;
      },
      cleanupAsync: async () => {
        exists = false;
        return true;
      },
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
  const firstCleanup = first.then((snapshot) => snapshot.cleanup());
  produced.resolve();
  const snapshot = await second;
  try {
    expect(await firstCleanup).toBe(true);
    expect(copies).toBe(1);
    expect(exists).toBe(true);
  } finally {
    await snapshot.cleanupAsync();
  }
  expect(exists).toBe(false);
});
