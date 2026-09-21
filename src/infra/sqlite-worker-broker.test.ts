import * as os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as logging from "../logging/logger.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "./sqlite-worker-store.js";
import type { FixtureOperations } from "./sqlite-worker-store.test-support.js";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => 32,
}));

const stores = new Set<SqliteWorkerStore<FixtureOperations>>();
const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    try {
      await Promise.all([...stores].map((store) => store.close()));
    } finally {
      stores.clear();
      cleanup();
    }
  }),
);
const databasePath = () => path.join(dirs.make("sqlite-worker-broker-"), "store.sqlite");

async function open(file: string) {
  const store = await openSqliteWorkerStore<FixtureOperations>({
    moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
    databasePath: file,
    input: undefined,
  });
  stores.add(store);
  return store;
}

function append(store: SqliteWorkerStore<FixtureOperations>, value: string) {
  return store.execute({ type: "append", input: { value } });
}

function read(store: SqliteWorkerStore<FixtureOperations>) {
  return store.execute({ type: "read", input: undefined });
}

const nodeIt = process.versions.bun ? it.skip : it;

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
  const accepted = Promise.allSettled(Array.from({ length: 128 }, () => read(store)));
  const cancel = new AbortController();
  const waiting = store.execute(
    { type: "append", input: { value: "x".repeat(40 * 1024 * 1024) } },
    { signal: cancel.signal },
  );
  const outcome = Promise.allSettled([waiting]);
  try {
    await expect(append(store, "x".repeat(30 * 1024 * 1024))).rejects.toMatchObject({
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
      if (!store) {
        throw new Error("Fixture store missing");
      }
      threads.add((await append(store, "thread count")).threadId);
    }
    expect(threads.size).toBe(workers);
  } finally {
    await broker.close();
    parallelism.mockRestore();
  }
});
