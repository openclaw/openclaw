import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import * as os from "node:os";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import * as logging from "../logging/logger.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import {
  useSqliteWorkerStoreFixture,
  appendWorkerRow as append,
  readWorkerRows as read,
} from "./sqlite-worker-fixture.test-support.js";
import {
  reserveSqliteWorkerInputPreparation,
  runSqliteWorkerStoreOperation,
  runSqliteWorkerStoreWrite,
  type SqliteWorkerStore,
} from "./sqlite-worker-store.js";
import type { FixtureOperations } from "./sqlite-worker-store.test-support.js";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => 32,
}));

const { databasePath, open } = useSqliteWorkerStoreFixture("sqlite-worker-broker-", () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const nodeIt = process.versions.bun ? it.skip : it;

nodeIt("keeps an independent database responsive while another worker is at capacity", async () => {
  const busy = await open(databasePath());
  const independent = await open(databasePath());
  const busyThread = (await append(busy, "before saturation")).threadId;
  const held = createDeferredCore();
  let release: (() => void) | undefined;
  const messages = vi.spyOn(Worker.prototype, "emit");
  messages.mockImplementation(function (this: Worker, event: string | symbol, ...args: unknown[]) {
    if (event === "message" && this.threadId === busyThread) {
      messages.mockRestore();
      release = () => EventEmitter.prototype.emit.call(this, event, ...args);
      held.resolve();
      return true;
    }
    return EventEmitter.prototype.emit.call(this, event, ...args);
  });
  const accepted = Promise.allSettled(
    Array.from({ length: 128 }, (_, index) => append(busy, String(index))),
  );
  const canceled = new Error("Waiting command canceled");
  const revoked = new Error("Waiting command authority revoked");
  let waiting: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await held.promise;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const completed = expect(append(independent, "independent write")).resolves.toMatchObject({
      writes: 1,
    });
    // A different worker must not spend the busy worker's admission timeout waiting for room.
    vi.advanceTimersByTime(10_000);
    await completed;
    expect(await read(independent)).toEqual(["independent write"]);
    vi.useRealTimers();
    const cancel = new AbortController();
    let current = true;
    waiting = Promise.allSettled([
      busy.execute({ type: "append", input: { value: "canceled" } }, { signal: cancel.signal }),
      runSqliteWorkerStoreOperation(
        busy,
        (scope) => scope.execute({ type: "append", input: { value: "revoked" } }),
        undefined,
        () => {
          if (!current) {
            throw revoked;
          }
        },
      ),
      append(busy, "oldest surviving waiter"),
      append(busy, "later arrival"),
    ]);
    current = false;
    cancel.abort(canceled);
  } finally {
    vi.useRealTimers();
    messages.mockRestore();
    release?.();
    expect((await accepted).every((outcome) => outcome.status === "fulfilled")).toBe(true);
  }
  expect(await waiting).toMatchObject([
    { status: "rejected", reason: canceled },
    { status: "rejected", reason: revoked },
    { status: "fulfilled" },
    { status: "fulfilled" },
  ]);
  expect(await read(busy)).toEqual([
    "before saturation",
    ...Array.from({ length: 128 }, (_, index) => String(index)),
    "oldest surviving waiter",
    "later arrival",
  ]);
});

it.each([
  { writeAdmission: false, revoke: false },
  { writeAdmission: false, revoke: true },
  { writeAdmission: true, revoke: false },
  { writeAdmission: true, revoke: true },
])(
  "retains queued command context and live ownership (write admission: $writeAdmission, revoke: $revoke)",
  async ({ writeAdmission, revoke }) => {
    const file = databasePath();
    const store = await open(file);
    const caller = new AsyncLocalStorage<{ current: boolean }>();
    const owner = { current: true };
    const revoked = new Error("Queued command owner was revoked");
    const assertCurrent = () => {
      if (caller.getStore() !== owner) {
        throw new Error("Queued command lost its caller context");
      }
      if (!owner.current) {
        throw revoked;
      }
    };
    const write = (scope: Pick<SqliteWorkerStore<FixtureOperations>, "execute">) =>
      scope.execute({ type: "append", input: { value: "queued" } });

    // Both commands enqueue before a Worker reply can dispatch the guarded follower.
    const predecessor = append(store, "before");
    const queued = caller.run(owner, () =>
      writeAdmission
        ? runSqliteWorkerStoreWrite(store, write, assertCurrent, [file])
        : runSqliteWorkerStoreOperation(store, write, undefined, assertCurrent),
    );
    const outcomes = Promise.allSettled([predecessor, queued]);
    owner.current = !revoke;

    const [first, second] = await outcomes;
    expect(first.status).toBe("fulfilled");
    if (revoke) {
      expect(second).toEqual({ status: "rejected", reason: revoked });
    } else {
      expect(second.status).toBe("fulfilled");
    }
    expect(await read(store)).toEqual(revoke ? ["before"] : ["before", "queued"]);
    expect(caller.getStore()).toBeUndefined();
  },
);

it.each(["abort", "drain", "timeout"] as const)(
  "releases admission waiters on %s without losing accepted writes",
  async (action) => {
    const file = databasePath();
    const store = await open(file);
    const accepted = Promise.allSettled(
      Array.from({ length: 128 }, (_, index) => append(store, String(index))),
    );
    const cancel = new AbortController();
    const reason = new Error("waiting caller canceled");
    const logger = logging.getChildLogger();
    const warn = vi.spyOn(logger, "warn");
    const logs = vi.spyOn(logging, "getChildLogger").mockReturnValue(logger);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    const waiters = Promise.allSettled(
      Array.from({ length: 2 }, () =>
        store.execute(
          { type: "append", input: { value: "never dispatched" } },
          { signal: cancel.signal },
        ),
      ),
    );
    let settled = false;
    void waiters.then(() => {
      settled = true;
    });
    let closing: Promise<void> | undefined;
    try {
      await Promise.resolve();
      expect(settled).toBe(false);
      if (action === "abort") {
        cancel.abort(reason);
      } else if (action === "drain") {
        closing = drainGlobalSingletonLifecycleState("restart");
      } else {
        vi.advanceTimersByTime(9_999);
        await Promise.resolve();
        expect(settled).toBe(false);
        vi.advanceTimersByTime(1);
      }
      for (const outcome of await waiters) {
        expect(outcome).toMatchObject({
          status: "rejected",
          reason: action === "abort" ? reason : { code: "overloaded" },
        });
      }
      if (action === "timeout") {
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith("SQLite worker admission delayed", {
          queueDepth: 2,
          waitMs: 10_000,
        });
      }
    } finally {
      vi.useRealTimers();
      logs.mockRestore();
      warn.mockRestore();
      cancel.abort(reason);
      expect((await accepted).every((outcome) => outcome.status === "fulfilled")).toBe(true);
      await closing;
    }
    const reader = action === "drain" ? await open(file) : store;
    expect(await read(reader)).toEqual(Array.from({ length: 128 }, (_, index) => String(index)));
    expect(await append(reader, "capacity returned")).toMatchObject({
      writes: action === "drain" ? 1 : 129,
    });
  },
);

it("charges admission waiters to the byte budget and releases canceled reservations", async () => {
  const store = await open(databasePath());
  const independent = await open(databasePath());
  const concurrentInputs = Array.from({ length: 3 }, () =>
    reserveSqliteWorkerInputPreparation(64 * 1024 * 1024),
  );
  const accepted = Promise.allSettled(Array.from({ length: 128 }, () => read(store)));
  const cancel = new AbortController();
  const waiting = store.execute(
    { type: "append", input: { value: "x".repeat(40 * 1024 * 1024) } },
    { signal: cancel.signal },
  );
  const outcome = Promise.allSettled([waiting]);
  try {
    await expect(append(independent, "x".repeat(30 * 1024 * 1024))).rejects.toMatchObject({
      code: "overloaded",
    });
    cancel.abort(new Error("release waiting bytes"));
    expect(await outcome).toMatchObject([
      { status: "rejected", reason: { message: "release waiting bytes" } },
    ]);
    const replacement = new AbortController();
    const replacementOutcome = Promise.allSettled([
      store.execute(
        { type: "append", input: { value: "x".repeat(40 * 1024 * 1024) } },
        { signal: replacement.signal },
      ),
    ]);
    replacement.abort(new Error("replacement admitted"));
    expect(await replacementOutcome).toMatchObject([
      { status: "rejected", reason: { message: "replacement admitted" } },
    ]);
  } finally {
    for (const prepared of concurrentInputs) {
      prepared.release();
    }
    cancel.abort();
    await outcome;
    await accepted;
  }
  expect(await read(store)).toEqual([]);
});

nodeIt.each([
  { cores: 1, workers: 2 },
  { cores: 24, workers: 3 },
  { cores: 128, workers: 8 },
])("uses $workers worker threads for $cores available CPUs", async ({ cores, workers }) => {
  const parallelism = vi.spyOn(os, "availableParallelism").mockReturnValue(cores);
  const broker = new SqliteWorkerBroker();
  try {
    const threads = new Set<number>();
    for (let index = 0; index <= workers; index++) {
      const store = await broker.open<FixtureOperations>({
        moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
        databasePath: databasePath(),
        input: undefined,
      });
      assert(store, "Fixture store missing");
      threads.add((await append(store, "thread count")).threadId);
    }
    expect(threads.size).toBe(workers);
  } finally {
    await broker.close();
    parallelism.mockRestore();
  }
});
