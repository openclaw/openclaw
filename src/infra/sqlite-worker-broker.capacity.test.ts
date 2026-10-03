import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { initializeSqliteRuntimeCapabilities } from "./bun-sqlite-library.js";
import {
  captureRuntimeWorkerSource,
  withRuntimeWorkerGeneration,
} from "./runtime-worker-generation.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import { useSqliteWorkerStoreFixture } from "./sqlite-worker-fixture.test-support.js";
import type { SqliteWorkerStore } from "./sqlite-worker-store.js";
import type { FixtureOperations } from "./sqlite-worker-store.test-support.js";

await initializeSqliteRuntimeCapabilities();
const { databasePath, tempDirs } = useSqliteWorkerStoreFixture("sqlite-capacity-");
const brokers = new Set<SqliteWorkerBroker>();
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...brokers].map((broker) => broker.close()));
  brokers.clear();
});

async function retainedClients(count = 64) {
  const broker = new SqliteWorkerBroker();
  brokers.add(broker);
  const file = databasePath();
  const options = {
    moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
    databasePath: file,
    input: undefined,
  };
  const stores: SqliteWorkerStore<FixtureOperations>[] = [];
  const at = (index: number) => {
    const store = stores[index];
    assert(store, "Retained fixture client missing");
    return store;
  };
  const idle = new Set<number>();
  const retire = vi.fn((index: number) => (idle.has(index) ? at(index).close() : undefined));
  for (let index = 0; index < count; index++) {
    const store = await broker.open<FixtureOperations>(options, undefined, undefined, {
      retireIdle: () => retire(index),
    });
    assert(store);
    stores.push(store);
  }
  const open = () => broker.open<FixtureOperations>(options);
  return { broker, options, stores, at, idle, retire, open };
}

it("reuses owner-confirmed idle reservations without raising the 64-client limit", async () => {
  const f = await retainedClients();
  await expect(f.open()).rejects.toMatchObject({ code: "overloaded" });
  await f.at(0).execute({ type: "append", input: { value: "before retirement" } });
  f.idle.add(0);
  const replacement = await f.open();
  assert(replacement);
  expect(f.broker.isAvailable(f.at(0))).toBe(false);
  expect(await replacement.execute({ type: "read", input: undefined })).toEqual([
    "before retirement",
  ]);
  await expect(f.open()).rejects.toMatchObject({ code: "overloaded" });
  expect(f.broker.isAvailable(f.at(1))).toBe(true);
});

it("protects accepted scopes and pending commands even if an owner offers retirement", async () => {
  const f = await retainedClients();
  f.idle.add(0);
  const entered = createDeferredCore();
  const finish = createDeferredCore();
  const operation = f.broker.runOperation(f.at(0), async (scope) => {
    entered.resolve();
    await finish.promise;
    return scope.execute({ type: "append", input: { value: "scope write" } });
  });
  await entered.promise;
  f.retire.mockClear();
  try {
    await expect(f.open()).rejects.toMatchObject({ code: "overloaded" });
    expect(f.retire.mock.calls.some(([index]) => index === 0)).toBe(false);
  } finally {
    finish.resolve();
    await operation;
  }
  const held = createDeferredCore();
  let publish: (() => void) | undefined;
  const messages = vi.spyOn(Worker.prototype, "emit").mockImplementationOnce(function (
    this: Worker,
    event: string | symbol,
    ...args: unknown[]
  ) {
    messages.mockRestore();
    publish = () => this.emit(event, ...args);
    held.resolve();
    return true;
  });
  const writes = Promise.all([
    f.at(0).execute({ type: "append", input: { value: "dispatched" } }),
    f.at(0).execute({ type: "append", input: { value: "queued" } }),
  ]);
  try {
    await held.promise;
    await expect(f.open()).rejects.toMatchObject({ code: "overloaded" });
  } finally {
    messages.mockRestore();
    publish?.();
    await writes;
  }
  const replacement = await f.open();
  assert(replacement);
  expect(await replacement.execute({ type: "read", input: undefined })).toEqual([
    "scope write",
    "dispatched",
    "queued",
  ]);
});

it("serializes simultaneous reclamation and preserves the reservation bound", async () => {
  const f = await retainedClients();
  f.idle.add(0);
  f.idle.add(1);
  const outcomes = await Promise.allSettled([f.open(), f.open(), f.open()]);
  expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
  expect(f.broker.isAvailable(f.at(0))).toBe(false);
  expect(f.broker.isAvailable(f.at(1))).toBe(false);
  expect(f.broker.isAvailable(f.at(2))).toBe(true);
  await expect(f.open()).rejects.toMatchObject({ code: "overloaded" });
});

it("reserves reclaimed capacity atomically against a competing direct opener", async () => {
  const f = await retainedClients();
  f.idle.add(0);
  const started = createDeferredCore();
  let competing: Promise<PromiseSettledResult<unknown>[]> | undefined;
  let scheduled = false;
  const replacement = await f.broker.open<FixtureOperations>(f.options, undefined, () => {
    if (!scheduled && !f.broker.isAvailable(f.at(0))) {
      scheduled = true;
      queueMicrotask(() => {
        competing = Promise.allSettled([f.open()]);
        started.resolve();
      });
    }
  });
  assert(replacement);
  await started.promise;
  expect(await competing).toMatchObject([{ status: "rejected", reason: { code: "overloaded" } }]);
  expect(f.stores.filter((store) => f.broker.isAvailable(store))).toHaveLength(63);
  expect(f.broker.isAvailable(replacement)).toBe(true);
});

it("joins host drainage during reclamation without cycling through open admission", async () => {
  const f = await retainedClients();
  let draining: Promise<void> | undefined;
  f.retire.mockImplementation((index) => {
    if (index !== 0) {
      return undefined;
    }
    const closing = f.at(0).close();
    draining = f.broker.close();
    return closing;
  });
  await expect(f.open()).rejects.toMatchObject({ code: "closed" });
  expect(draining).toBeDefined();
  await draining;
});

it("bounds pending reclamation opens even when their captured input is tiny", async () => {
  const f = await retainedClients();
  const entered = createDeferredCore();
  const finish = createDeferredCore();
  f.retire.mockImplementation((index) => {
    if (index !== 0) {
      return undefined;
    }
    const closing = f.at(0).close();
    entered.resolve();
    return closing.then(() => finish.promise);
  });
  const first = f.open();
  await entered.promise;
  const pending = Promise.allSettled(Array.from({ length: 63 }, () => f.open()));
  try {
    await expect(f.open()).rejects.toMatchObject({
      code: "overloaded",
      message: "SQLite worker open input capacity reached",
    });
  } finally {
    finish.resolve();
    await first;
    await pending;
  }
});

it("checks queued opener authority before retiring an idle owner", async () => {
  const f = await retainedClients();
  const entered = createDeferredCore();
  const finish = createDeferredCore();
  f.retire.mockImplementation((index) => {
    if (index !== 0) {
      return undefined;
    }
    const closing = f.at(0).close();
    entered.resolve();
    return closing.then(() => finish.promise);
  });
  const first = f.open();
  await entered.promise;
  let current = true;
  const revoked = new Error("Opening owner was revoked");
  const refused = Promise.allSettled([
    f.broker.open(f.options, undefined, () => {
      if (!current) {
        throw revoked;
      }
    }),
  ]);
  current = false;
  f.retire.mockClear();
  finish.resolve();
  await first;
  expect(await refused).toEqual([{ status: "rejected", reason: revoked }]);
  expect(f.retire).not.toHaveBeenCalled();
  expect(f.broker.isAvailable(f.at(1))).toBe(true);
});

it("does not reclaim idle stores from another retained runtime generation", async () => {
  const f = await retainedClients();
  f.idle.add(0);
  f.retire.mockClear();
  const retained = pathToFileURL(path.join(tempDirs.make("retained-capacity-"), "backend.mts"));
  await writeFile(retained, `export * from ${JSON.stringify(f.options.moduleUrl.href)};\n`);
  await withRuntimeWorkerGeneration(
    async (bind) => {
      bind((url) => (url.href === f.options.moduleUrl.href ? retained : url));
      const source = captureRuntimeWorkerSource(f.options.moduleUrl);
      expect(source.runtimeGeneration).toBeDefined();
      await expect(f.broker.open({ ...f.options, ...source })).rejects.toMatchObject({
        code: "overloaded",
      });
    },
    async () => {},
  );
  expect(f.retire).not.toHaveBeenCalled();
  expect(f.broker.isAvailable(f.at(0))).toBe(true);
});

it("waits for reclaimed native retirement before replacement admission", async () => {
  const f = await retainedClients(63);
  const options = { ...f.options, databasePath: databasePath() };
  const idle: SqliteWorkerStore<FixtureOperations> | undefined =
    await f.broker.open<FixtureOperations>(options, undefined, undefined, {
      retireIdle: () => idle?.close(),
    });
  assert(idle);
  const entered = createDeferredCore();
  const finish = createDeferredCore();
  const termination = vi.spyOn(Worker.prototype, "terminate").mockImplementationOnce(function (
    this: Worker,
  ) {
    termination.mockRestore();
    entered.resolve();
    return finish.promise.then(() => this.terminate());
  });
  let admitted = false;
  const replacement = f.open().then((store) => {
    admitted = true;
    return store;
  });
  try {
    await entered.promise;
    await f.at(0).execute({ type: "append", input: { value: "healthy peer" } });
    expect(admitted).toBe(false);
  } finally {
    finish.resolve();
    termination.mockRestore();
    await replacement;
  }
});

it("reports reclaimed native cleanup failure and restores capacity after settlement", async () => {
  const f = await retainedClients(63);
  const options = { ...f.options, databasePath: databasePath() };
  const idle: SqliteWorkerStore<FixtureOperations> | undefined =
    await f.broker.open<FixtureOperations>(options, undefined, undefined, {
      retireIdle: () => idle?.close(),
    });
  assert(idle);
  await idle.execute({ type: "append", input: { value: "committed" } });
  await idle.execute({ type: "failClose", input: undefined });
  await expect(f.open()).rejects.toThrow("Fixture native database closed with a cleanup failure");
  const recovered = await f.broker.open<FixtureOperations>(options);
  assert(recovered);
  expect(await recovered.execute({ type: "read", input: undefined })).toEqual(["committed"]);
  expect(await f.at(0).execute({ type: "read", input: undefined })).toEqual([]);
});
