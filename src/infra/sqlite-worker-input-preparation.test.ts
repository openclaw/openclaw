import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import type { FixtureOperations } from "./sqlite-worker-store.test-support.js";

const MIB = 1024 * 1024;
const brokers = new Set<SqliteWorkerBroker>();
const concurrentInputs = new Set<ReturnType<SqliteWorkerBroker["reserveInputPreparation"]>>();
const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const prepared of concurrentInputs) {
      prepared.release();
    }
    concurrentInputs.clear();
    try {
      await Promise.all([...brokers].map((broker) => broker.close()));
    } finally {
      brokers.clear();
      cleanup();
    }
  }),
);

function createBroker() {
  const broker = new SqliteWorkerBroker();
  brokers.add(broker);
  return broker;
}

function reserveConcurrentInputs(broker: SqliteWorkerBroker) {
  for (let index = 0; index < 3; index += 1) {
    concurrentInputs.add(broker.reserveInputPreparation(64 * MIB));
  }
}

async function open(broker: SqliteWorkerBroker) {
  const store = await broker.open<FixtureOperations>({
    moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
    databasePath: path.join(dirs.make("sqlite-input-preparation-"), "store.sqlite"),
    input: undefined,
  });
  if (!store) {
    throw new Error("Fixture store did not open");
  }
  return store;
}

it("charges preparing inputs and dispatched commands to the same byte budget", async () => {
  const broker = createBroker();
  const store = await open(broker);
  reserveConcurrentInputs(broker);
  const prepared = broker.reserveInputPreparation(64 * MIB);
  try {
    await expect(
      store.execute({ type: "append", input: { value: "must not enter" } }),
    ).rejects.toMatchObject({ code: "overloaded" });
  } finally {
    prepared.release();
  }
  const accepted = store.execute({ type: "append", input: { value: "accepted" } });
  // No event-loop turn lets the worker reply release this dispatched command yet.
  expect(() => broker.reserveInputPreparation(64 * MIB)).toThrow(
    expect.objectContaining({ code: "overloaded" }),
  );
  await accepted;
  const recovered = broker.reserveInputPreparation(64 * MIB);
  recovered.release();
  expect(await store.execute({ type: "read", input: undefined })).toEqual(["accepted"]);
});

it.each([
  { limit: "message", reservedMiB: 0, inputMiB: 16, preparationMiB: 16 },
  { limit: "queue", reservedMiB: 61, inputMiB: 1, preparationMiB: 3 },
])(
  "charges opening input and preparation together against the $limit limit",
  async ({ reservedMiB, inputMiB, preparationMiB }) => {
    const broker = createBroker();
    reserveConcurrentInputs(broker);
    const databasePath = path.join(dirs.make("sqlite-opening-budget-"), "store.sqlite");
    const prepared = broker.reserveInputPreparation(reservedMiB * MIB);
    const options = {
      moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
      databasePath,
      input: "x".repeat(inputMiB * MIB),
    };
    try {
      await expect(
        broker.open<FixtureOperations>(options, undefined, undefined, {
          preparation: "y".repeat(preparationMiB * MIB),
        }),
      ).rejects.toMatchObject({ code: "overloaded" });
      expect(existsSync(databasePath)).toBe(false);
    } finally {
      prepared.release();
    }
    const store = await broker.open<FixtureOperations>({ ...options, input: undefined });
    expect(await store?.execute({ type: "read", input: undefined })).toEqual([]);
    await store?.close();
  },
);

it("bounds oversized preparation and releases each reservation only once", () => {
  const broker = createBroker();
  const first = broker.reserveInputPreparation(100 * MIB);
  const second = broker.reserveInputPreparation(100 * MIB);
  const concurrent: ReturnType<typeof broker.reserveInputPreparation>[] = [];
  try {
    for (let index = 0; index < 3; index += 1) {
      concurrent.push(broker.reserveInputPreparation(64 * MIB));
    }
    expect(() => broker.reserveInputPreparation(1)).toThrow(
      expect.objectContaining({ code: "overloaded" }),
    );
    first.release();
    first.release();
    const replacement = broker.reserveInputPreparation(32 * MIB);
    try {
      expect(() => broker.reserveInputPreparation(1)).toThrow(
        expect.objectContaining({ code: "overloaded" }),
      );
    } finally {
      replacement.release();
    }
  } finally {
    for (const prepared of concurrent) {
      prepared.release();
    }
    first.release();
    second.release();
  }
});

it("joins captured input before drainage returns and refuses stale handoff", async () => {
  const broker = createBroker();
  const prepared = broker.reserveInputPreparation(40 * MIB);
  let closed = false;
  const closing = broker.close().then(() => {
    closed = true;
  });
  expect(() => broker.reserveInputPreparation(1)).toThrow(
    expect.objectContaining({ code: "closed" }),
  );
  // This empty broker has only microtasks to settle before it waits for retained input.
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(closed).toBe(false);
  expect(() => prepared.assertCurrent()).toThrow(expect.objectContaining({ code: "closed" }));
  const dispatch = vi.fn(() => Promise.resolve());
  expect(() => prepared.handoff(dispatch)).toThrow(expect.objectContaining({ code: "closed" }));
  expect(dispatch).not.toHaveBeenCalled();
  prepared.release();
  await closing;
  const recovered = broker.reserveInputPreparation(64 * MIB);
  recovered.release();
});

it.each(["serialization", "cancellation"] as const)(
  "releases preparation when actual dispatch fails during %s",
  async (failure) => {
    const broker = createBroker();
    const store = await open(broker);
    reserveConcurrentInputs(broker);
    const prepared = broker.reserveInputPreparation(64 * MIB);
    const reason = new Error("caller canceled before dispatch");
    const result = prepared.handoff(() =>
      failure === "serialization"
        ? store.execute({
            type: "append",
            input: Object.assign({ value: "must not enter" }, { uncloneable: () => {} }),
          })
        : store.execute(
            { type: "append", input: { value: "must not enter" } },
            { signal: AbortSignal.abort(reason) },
          ),
    );
    if (failure === "cancellation") {
      await expect(result).rejects.toBe(reason);
    } else {
      await expect(result).rejects.toBeInstanceOf(Error);
    }
    prepared.release();
    const recovered = broker.reserveInputPreparation(64 * MIB);
    recovered.release();
    expect(await store.execute({ type: "read", input: undefined })).toEqual([]);
  },
);

it("hands preparation into synchronous execute without charging it twice", async () => {
  const broker = createBroker();
  const store = await open(broker);
  reserveConcurrentInputs(broker);
  const prepared = broker.reserveInputPreparation(64 * MIB);
  const command = { type: "append" as const, input: { value: "captured at handoff" } };
  const result = prepared.handoff(() => store.execute(command));
  command.input.value = "changed after handoff";
  await expect(result).resolves.toMatchObject({ writes: 1 });
  const dispatchAgain = vi.fn(() => store.execute(command));
  expect(() => prepared.handoff(dispatchAgain)).toThrow(
    expect.objectContaining({ code: "closed" }),
  );
  expect(dispatchAgain).not.toHaveBeenCalled();
  expect(await store.execute({ type: "read", input: undefined })).toEqual(["captured at handoff"]);
});

it("keeps oversized handoffs out of a busy worker slot", async () => {
  const broker = createBroker();
  const store = await open(broker);
  reserveConcurrentInputs(broker);
  const accepted = store.execute({ type: "append", input: { value: "first" } });
  const prepared = broker.reserveInputPreparation(100 * MIB);
  try {
    // Dispatch and serialization remain in one turn, so the first reply cannot settle yet.
    await expect(
      prepared.handoff(() =>
        store.execute({ type: "append", input: { value: "x".repeat(65 * MIB) } }),
      ),
    ).rejects.toMatchObject({ code: "overloaded" });
  } finally {
    prepared.release();
    await accepted;
  }
  const recovered = broker.reserveInputPreparation(64 * MIB);
  recovered.release();
  expect(await store.execute({ type: "read", input: undefined })).toEqual(["first"]);
});
