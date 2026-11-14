import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import { readWorkerRows } from "./sqlite-worker-fixture.test-support.js";
import type { FixtureOperations } from "./sqlite-worker-store.test-support.js";

const MIB = 1024 * 1024;
let broker: SqliteWorkerBroker;
beforeEach(() => {
  broker = new SqliteWorkerBroker();
});
const concurrentInputs = new Set<ReturnType<SqliteWorkerBroker["reserveInputPreparation"]>>();
const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const prepared of concurrentInputs) {
      prepared.release();
    }
    concurrentInputs.clear();
    try {
      await broker.close();
    } finally {
      cleanup();
    }
  }),
);

function reserveInput(mib: number, retention?: "stream" | "snapshot") {
  const prepared = broker.reserveInputPreparation(mib * MIB, retention);
  concurrentInputs.add(prepared);
  return prepared;
}

function reserveConcurrentInputs() {
  for (let index = 0; index < 3; index += 1) {
    reserveInput(64);
  }
}

function storeOptions(input?: string) {
  return {
    moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
    databasePath: path.join(dirs.make("sqlite-input-preparation-"), "store.sqlite"),
    input,
  };
}

const overloaded = expect.objectContaining({ code: "overloaded" });
const closedInput = expect.objectContaining({ code: "closed" });

async function open() {
  const store = await broker.open<FixtureOperations>(storeOptions());
  assert(store, "Fixture store did not open");
  return store;
}

it.each(["handoff", "serialization failure"] as const)(
  "transfers preparation custody through %s without leaking or double charging bytes",
  async (mode) => {
    const store = await open();
    reserveConcurrentInputs();
    const prepared = reserveInput(64);
    const command = {
      type: "append" as const,
      input: {
        value: "captured at handoff",
        ...(mode === "serialization failure" ? { uncloneable: () => {} } : {}),
      },
    };
    const result = prepared.handoff(() => store.execute(command));
    command.input.value = "changed after handoff";
    if (mode === "serialization failure") {
      await expect(result).rejects.toBeInstanceOf(Error);
    } else {
      // A dispatched command retains its byte charge until the worker replies.
      expect(() => broker.reserveInputPreparation(64 * MIB)).toThrow(overloaded);
      await expect(result).resolves.toMatchObject({ writes: 1 });
    }
    prepared.release();
    reserveInput(64).release();
    const dispatchAgain = vi.fn(() => store.execute(command));
    expect(() => prepared.handoff(dispatchAgain)).toThrow(closedInput);
    expect(dispatchAgain).not.toHaveBeenCalled();
    expect(await readWorkerRows(store)).toEqual(
      mode === "serialization failure" ? [] : ["captured at handoff"],
    );
  },
);

it.each([
  { limit: "message", reservedMiB: 0, inputMiB: 16, preparationMiB: 16 },
  { limit: "queue", reservedMiB: 61, inputMiB: 1, preparationMiB: 3 },
])(
  "charges opening input and preparation together against the $limit limit",
  async ({ reservedMiB, inputMiB, preparationMiB }) => {
    reserveConcurrentInputs();
    const prepared = reserveInput(reservedMiB);
    const options = storeOptions("x".repeat(inputMiB * MIB));
    await expect(
      broker.open<FixtureOperations>(options, undefined, undefined, {
        preparation: "y".repeat(preparationMiB * MIB),
      }),
    ).rejects.toMatchObject({ code: "overloaded" });
    expect(existsSync(options.databasePath)).toBe(false);
    prepared.release();
    const store = await broker.open<FixtureOperations>({ ...options, input: undefined });
    expect(await store?.execute({ type: "read", input: undefined })).toEqual([]);
    await store?.close();
  },
);

it.each(["stream", "snapshot"] as const)(
  "charges %s reservations and releases each charge only once",
  async (retention) => {
    const reserve = (mib: number) => reserveInput(mib, retention);
    const first = reserveInput(100, retention === "snapshot" ? retention : undefined);
    const second = reserve(100);
    if (retention === "snapshot") {
      expect(() => reserve(100)).toThrow(overloaded);
      reserve(56);
    } else {
      reserveConcurrentInputs();
    }
    expect(() => broker.reserveInputPreparation(1)).toThrow(overloaded);
    if (retention === "snapshot") {
      const reason = new Error("snapshot canceled before dispatch");
      await expect(first.handoff(() => Promise.reject(reason))).rejects.toBe(reason);
    }
    for (const prepared of [first, second]) {
      prepared.release();
      prepared.release();
      reserve(retention === "snapshot" ? 100 : 32);
      expect(() => broker.reserveInputPreparation(1)).toThrow(overloaded);
    }
  },
);

it("joins captured input before drainage returns and refuses stale handoff", async () => {
  const prepared = reserveInput(40);
  let closed = false;
  const closing = broker.close().then(() => {
    closed = true;
  });
  expect(() => broker.reserveInputPreparation(1)).toThrow(closedInput);
  // This empty broker has only microtasks to settle before it waits for retained input.
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(closed).toBe(false);
  expect(() => prepared.assertCurrent()).toThrow(closedInput);
  const dispatch = vi.fn(() => Promise.resolve());
  expect(() => prepared.handoff(dispatch)).toThrow(closedInput);
  expect(dispatch).not.toHaveBeenCalled();
  await closing;
  broker.reserveInputPreparation(64 * MIB).release();
});
