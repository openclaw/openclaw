import fs from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sqliteMaintenanceFixture } from "./sqlite-maintenance-fixture.test-support.js";
import { withSqliteReaderOwner } from "./sqlite-reader-lifecycle.js";
import { observeSqliteReaderCounters, type SqliteReaderCounter } from "./sqlite-reader-metrics.js";
import { runSqliteDeferredTransactionSync } from "./sqlite-transaction.js";
import { readThreadDiskReadBytes } from "./thread-disk-io.js";

const { warn } = vi.hoisted(() => {
  vi.resetModules();
  return { warn: vi.fn() };
});
vi.mock("node:worker_threads", async (original) => ({
  ...(await original<typeof import("node:worker_threads")>()),
  isMainThread: false,
}));
const resources = sqliteMaintenanceFixture();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const counters = new Map<string, SqliteReaderCounter>();
let stopCounters: () => unknown;
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "linux" });
  warn.mockReset();
  stopCounters = observeSqliteReaderCounters((counter) => counters.set(counter.operation, counter));
});
afterEach(() => {
  stopCounters();
  Object.defineProperty(process, "platform", platform);
});

function procfs(...samples: Array<number | string | Error>) {
  const read = fs.readFileSync;
  return vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
    if (file !== "/proc/thread-self/io") {
      return read(file, options);
    }
    const value = samples.shift();
    if (value instanceof Error) {
      throw value;
    }
    return typeof value === "number"
      ? `rchar: 999999999\nread_bytes: ${value}\nwrite_bytes: 0\n`
      : (value ?? "");
  });
}

it.each(["sync", "async", "rejected"])(
  "attributes one heavy %s operation across nested reads",
  async (kind) => {
    const previous = counters.get("sessions.history.summary")?.values.slice() ?? [0n, 0n];
    const db = resources.entries();
    const read = procfs(4096, 64 * 1024 * 1024 + 4096);
    const context = { sessionId: "synthetic", rows: 0 };
    const operation = () =>
      withSqliteReaderOwner({ operation: "nested", ownerKind: "worker" }, () =>
        runSqliteDeferredTransactionSync(
          db,
          () => {
            db.prepare("SELECT * FROM entries").all();
            context.rows = 12;
          },
          { operationLabel: "sessions.history.read", diagnosticContext: context },
        ),
      );
    const run = () =>
      withSqliteReaderOwner(
        { operation: "sessions.history.summary", ownerKind: "worker" },
        kind === "sync"
          ? operation
          : async () => {
              await Promise.resolve();
              operation();
              if (kind === "rejected") {
                throw new Error("original failure");
              }
              return 42;
            },
        { agentId: "synthetic-agent" },
        { warn },
      );
    if (kind === "rejected") {
      await expect(run()).rejects.toThrow("original failure");
    } else {
      await Promise.resolve(run());
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "heavy SQLite reader operation",
      expect.objectContaining({
        operation: "sessions.history.summary",
        readBytes: 64 * 1024 * 1024,
        context: {
          ...context,
          agentId: "synthetic-agent",
          readerOperation: "sessions.history.summary",
        },
      }),
    );
    expect(read.mock.calls.filter(([file]) => file === "/proc/thread-self/io")).toHaveLength(2);
    expect([...counters.get("sessions.history.summary")!.values]).toEqual([
      previous[0]! + 1n,
      previous[1]! + BigInt(64 * 1024 * 1024),
    ]);
    expect(counters.has("nested")).toBe(false);
  },
);

it("counts sub-threshold and zero-byte operations without additional registrations", () => {
  procfs(4096, 8192, 8192, 8192);
  const registered = vi.fn();
  const stop = observeSqliteReaderCounters(registered);
  registered.mockClear();
  for (let i = 0; i < 2; i++) {
    withSqliteReaderOwner(
      { operation: "sessions.small", ownerKind: "worker" },
      () => 42,
      undefined,
      { warn },
    );
  }
  stop();
  expect([...counters.get("sessions.small")!.values]).toEqual([2n, 4096n]);
  expect(registered).toHaveBeenCalledTimes(1);
  expect(warn).not.toHaveBeenCalled();
});

it.each([
  [0, 64 * 1024 * 1024 - 1],
  [4096, 0],
  [0, "rchar: 999999999\n"],
  [new Error("EACCES"), 999999999],
  [0, new Error("ENOENT")],
])("keeps small or unavailable counters silent (%s, %s)", (before, after) => {
  const previous = counters.get("small")?.values.slice() ?? [0n, 0n];
  procfs(before, after);
  expect(
    withSqliteReaderOwner({ operation: "small", ownerKind: "worker" }, () => 42, undefined, {
      warn,
    }),
  ).toBe(42);
  expect(warn).not.toHaveBeenCalled();
  const measured = typeof before === "number" && typeof after === "number" && after >= before;
  expect([...(counters.get("small")?.values ?? [0n, 0n])]).toEqual([
    previous[0]! + (measured ? 1n : 0n),
    previous[1]! + (measured ? BigInt(after - before) : 0n),
  ]);
});

it("does not read procfs off Linux or for main-thread owners", () => {
  const read = procfs(0, 999999999);
  withSqliteReaderOwner({ operation: "main", ownerKind: "main" }, () => 42, undefined, { warn });
  Object.defineProperty(process, "platform", { value: "darwin" });
  expect(readThreadDiskReadBytes()).toBeUndefined();
  withSqliteReaderOwner({ operation: "worker", ownerKind: "worker" }, () => 42, undefined, {
    warn,
  });
  expect(read).not.toHaveBeenCalled();
});

it("preserves the synchronous failure when the heavy-read sink throws", () => {
  procfs(0, 64 * 1024 * 1024);
  warn.mockImplementation(() => {
    throw new Error("sink failed");
  });
  expect(() =>
    withSqliteReaderOwner(
      { operation: "failed", ownerKind: "worker" },
      () => {
        throw new Error("original failure");
      },
      undefined,
      { warn },
    ),
  ).toThrow("original failure");
});

it("bounds operation labels without dropping overflow reads", () => {
  const total = () =>
    [...counters.values()].reduce((sum, counter) => sum + Number(counter.values[0]), 0);
  const before = total();
  procfs(...Array.from({ length: 600 }, (_, index) => index * 4096));
  for (let index = 0; index < 300; index++) {
    withSqliteReaderOwner(
      { operation: `synthetic.${index}`, ownerKind: "worker" },
      () => 42,
      undefined,
      { warn },
    );
  }
  expect(counters.size).toBeLessThanOrEqual(257);
  expect(total() - before).toBe(300);
  expect(counters.get("other")!.values[0]).toBeGreaterThan(0n);
});
