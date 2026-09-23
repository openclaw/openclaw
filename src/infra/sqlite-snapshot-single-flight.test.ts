import { expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { prepareSingleFlightSqliteSnapshot } from "./sqlite-snapshot-single-flight.js";

it.each([1, 2])("withdraws %i cancelled waiters before admitting snapshot work", async (count) => {
  let copies = 0;
  const controllers = Array.from({ length: count }, () => new AbortController());
  const operations = controllers.map((controller) =>
    prepareSingleFlightSqliteSnapshot(
      `cancelled-demand-${count}.sqlite`,
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

it("tracks the producer after a caller cancels its wait", async () => {
  const admitted = createDeferred();
  const produced = createDeferred();
  const tracked: Promise<unknown>[] = [];
  const controller = new AbortController();
  const pending = prepareSingleFlightSqliteSnapshot(
    "producer-drain.sqlite",
    "test",
    async () => {
      admitted.resolve();
      await produced.promise;
      return {
        location: "snapshot.sqlite",
        cleanup: () => true,
        cleanupAsync: async () => true,
      };
    },
    controller.signal,
    { trackProducer: (producer) => tracked.push(producer) },
  );

  await admitted.promise;
  controller.abort(new Error("caller stopped waiting"));
  await expect(pending).rejects.toThrow("caller stopped waiting");
  expect(tracked).toHaveLength(1);
  let producerSettled = false;
  void tracked[0]?.then(() => {
    producerSettled = true;
  });
  await Promise.resolve();
  expect(producerSettled).toBe(false);
  produced.resolve();
  await expect(tracked[0]).resolves.toMatchObject({ location: "snapshot.sqlite" });
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
  let settled = false;
  void tracked[0]?.then(() => {
    settled = true;
  });
  produced.resolve();
  await cleanupStarted.promise;
  await Promise.resolve();
  await Promise.resolve();
  const settledBeforeCleanup = settled;
  cleanupFinished.resolve();
  await tracked[0];
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

it("cancels queued snapshot allocation when its only waiter aborts", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled before snapshot allocation");
  let allocated = false;
  const pending = prepareSingleFlightSqliteSnapshot(
    "cancelled-queued-source.sqlite",
    "test",
    async (signal) => {
      signal.throwIfAborted();
      allocated = true;
      return {
        location: "unused-snapshot.sqlite",
        cleanup: () => true,
        cleanupAsync: async () => true,
      };
    },
    controller.signal,
  );
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(allocated).toBe(false);
});

it("keeps queued production for a surviving waiter after the first aborts", async () => {
  const controller = new AbortController();
  const reason = new Error("first waiter stopped");
  const produced = createDeferred();
  const entered = createDeferred();
  let cleaned = false;
  const producer = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    entered.resolve();
    await produced.promise;
    signal.throwIfAborted();
    return {
      location: "surviving-snapshot.sqlite",
      cleanup: () => true,
      cleanupAsync: async () => {
        cleaned = true;
        return true;
      },
    };
  };
  const first = prepareSingleFlightSqliteSnapshot(
    "surviving-queued-source.sqlite",
    "test",
    producer,
    controller.signal,
  );
  const second = prepareSingleFlightSqliteSnapshot(
    "surviving-queued-source.sqlite",
    "test",
    producer,
  );
  controller.abort(reason);
  try {
    await expect(first).rejects.toBe(reason);
    await entered.promise;
    expect(cleaned).toBe(false);
  } finally {
    produced.resolve();
    const snapshot = await second;
    expect(snapshot.location).toBe("surviving-snapshot.sqlite");
    expect(await snapshot.cleanupAsync()).toBe(true);
  }
  expect(cleaned).toBe(true);
});
