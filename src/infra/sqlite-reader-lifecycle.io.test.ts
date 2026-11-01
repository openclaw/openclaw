import fs from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sqliteMaintenanceFixture } from "./sqlite-maintenance-fixture.test-support.js";
import { withSqliteReaderOwner } from "./sqlite-reader-lifecycle.js";
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
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "linux" });
  warn.mockReset();
});
afterEach(() => Object.defineProperty(process, "platform", platform));

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
  },
);

it.each([
  [0, 64 * 1024 * 1024 - 1],
  [4096, 0],
  [0, "rchar: 999999999\n"],
  [new Error("EACCES"), 999999999],
  [0, new Error("ENOENT")],
])("keeps small or unavailable counters silent (%s, %s)", (before, after) => {
  procfs(before, after);
  expect(
    withSqliteReaderOwner({ operation: "small", ownerKind: "worker" }, () => 42, undefined, {
      warn,
    }),
  ).toBe(42);
  expect(warn).not.toHaveBeenCalled();
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
