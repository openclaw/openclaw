import { DeleteQueryNode } from "kysely";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { getNodeSqliteKysely } from "./kysely-sync.js";
import {
  createSqliteAuditRecordReader,
  createSqliteAuditRecordWriter,
} from "./sqlite-audit-record-store.async.js";
import { createSqliteAuditRecordStore as createNativeSqliteAuditRecordStore } from "./sqlite-audit-record-store.js";
import {
  createSqliteAuditRecordKernel,
  prepareSqliteAuditRecord,
} from "./sqlite-audit-record.kernel.js";

// Migration fixtures use the same transaction-bound kernel as schema migration.
function createSqliteAuditRecordStore<T>(
  options: Parameters<typeof createNativeSqliteAuditRecordStore<T>>[0],
) {
  return {
    ...createNativeSqliteAuditRecordStore<T>(options),
    register(key: string, value: T, createdAt = Date.now()): void {
      const record = prepareSqliteAuditRecord(options.scope, { key, value, createdAt });
      runOpenClawStateWriteTransaction(
        ({ db }) => createSqliteAuditRecordKernel<T>(db, options).register(record),
        options,
      );
    },
  };
}

const tempDirs = createTempDirTracker();
afterEach(async () => {
  vi.restoreAllMocks();
  try {
    await closeOpenClawStateDatabaseAsync();
  } finally {
    tempDirs.cleanup();
  }
});

function fixture<T = { value: number }>(
  scope: string,
  maxEntries = 2,
  env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("openclaw-audit-") },
) {
  const options = { scope, maxEntries, env };
  return {
    options,
    store: createSqliteAuditRecordStore<T>(options),
    write: () => createSqliteAuditRecordWriter<T>(options),
    read: () => createSqliteAuditRecordReader<T>(options),
  };
}

function row(key: string, value: number, createdAt: number, sequence?: number) {
  return { key, value: { value }, createdAt, ...(sequence === undefined ? {} : { sequence }) };
}

function expectLatest(
  store: { latest: (params: { limit: number }) => unknown },
  rows: ReturnType<typeof row>[],
  limit = 2,
) {
  expect(store.latest({ limit })).toEqual(rows);
}

function rejectPruning(
  options: Parameters<typeof createNativeSqliteAuditRecordStore>[0],
  message: string,
  temporary = false,
) {
  const { db } = openOpenClawStateDatabase(options);
  db.exec(`CREATE ${temporary ? "TEMP" : ""} TRIGGER reject_pruning BEFORE DELETE ON diagnostic_events
  WHEN OLD.scope = '${options.scope}' AND OLD.event_key = 'one'
  BEGIN SELECT RAISE(ABORT, '${message}'); END;`);
  return () => db.exec("DROP TRIGGER reject_pruning");
}

const greeting = (text: string, cursor = 0) => ({ text, cursor });
type AuditEvent = { event: string };
type Greeting = { text: string; cursor: number };

it("refreshes sequence and retention facts after foreign writes and duplicate legacy rows", async () => {
  const { store: native, write } = fixture("write-facts", 3);
  const writer = write();
  native.registerLegacyMany([row("legacy", 0, 0), row("legacy", 99, 1)]);
  await writer.register("first", { value: 1 }, 1);
  native.register("foreign", { value: 2 }, 2);
  await writer.register("second", { value: 3 }, 3);
  expectLatest(native, [row("second", 3, 3, 3), row("foreign", 2, 2, 2), row("first", 1, 1, 1)], 5);
  await writer.register("first", { value: 99 }, 99);
  expect(native.entries()).toHaveLength(3);
  await expect(writer.compareAndSet("foreign", { value: 2 }, null)).resolves.toBe(true);
  native.registerLegacyMany([row("legacy", 4, 4), row("legacy", 99, 5)]);
  await writer.register("third", { value: 5 }, 5);
  expectLatest(native, [row("third", 5, 5, 4), row("second", 3, 3, 3), row("first", 1, 1, 1)], 5);
});

it("scans older config edits and rejects all facts when a later page is corrupt", async () => {
  const { options, store: native, read } = fixture<AuditEvent>("config-audit", 10);
  native.register("old-external", { event: "config.external" }, 1);
  for (let sequence = 2; sequence <= 8; sequence += 1) {
    native.register(`write-${sequence}`, { event: "config.write" }, sequence);
  }
  const reader = read();
  const expectFacts = (after: number, recentExternalEdit: boolean) =>
    expect(reader.configAuditFacts(after)).resolves.toEqual({
      auditSequence: 8,
      recentExternalEdit,
    });
  await expectFacts(0, true);
  await expectFacts(1, false);

  native.upsert("write-8", { event: "config.external" }, 8);
  const { db } = openOpenClawStateDatabase(options);
  db.prepare("UPDATE diagnostic_events SET payload_json = ? WHERE scope = ? AND event_key = ?").run(
    "{",
    options.scope,
    "old-external",
  );

  await expect(reader.configAuditFacts(0)).rejects.toThrow(/JSON|Unexpected|property name/i);
  await expectFacts(5, true);
});

it("settles competing worker comparisons against current rows and captures submitted values", async () => {
  const { store: native, write, read } = fixture<Greeting>("greeting-cas", 1);
  const initial = greeting("initial");
  native.register("latest", initial, 1);
  const firstWriter = write();
  const secondWriter = write();
  const reader = read();
  expect((await reader.latest({ limit: 1 }))[0]?.value).toEqual(initial);

  const expected = greeting("initial");
  const replacement = greeting("greeting");
  const first = firstWriter.compareAndSet("latest", expected, replacement, 2);
  const second = secondWriter.compareAndSet("latest", initial, greeting("initial", 7), 3);
  expected.cursor = 99;
  replacement.text = "mutated after submission";

  await expect(Promise.all([first, second])).resolves.toEqual([true, false]);
  expect((await reader.latest({ limit: 1 }))[0]).toMatchObject({
    value: greeting("greeting"),
    createdAt: 2,
    sequence: 1,
  });

  const foreign = greeting("foreign commit", 8);
  const next = greeting("next greeting", 8);
  native.upsert("latest", foreign, 4);
  expect((await reader.latest({ limit: 1 }))[0]?.value).toEqual(foreign);
  await expect(secondWriter.compareAndSet("latest", foreign, next, 5)).resolves.toBe(true);
  expect(native.latest({ limit: 1 })[0]?.value).toEqual(next);
});

it("rolls back async insertion and retention together, preserving sibling scopes", async () => {
  const { options, store, write } = fixture("async-rollback", 2);
  const register = (...args: Parameters<ReturnType<typeof write>["register"]>) =>
    write().register(...args);
  const { store: sibling } = fixture("sibling", 2, options.env);
  store.register("one", { value: 1 }, 3);
  store.register("two", { value: 2 }, 2);
  sibling.register("one", { value: 9 }, 1);
  const before = store.latest({ limit: 3 });
  // Admit the worker before installing a cross-connection transaction fault.
  await register("two", { value: 2 }, 2);
  const restorePruning = rejectPruning(options, "async audit pruning refused");
  await expect(register("three", { value: 3 }, 1)).rejects.toThrow("async audit pruning refused");
  expect(store.latest({ limit: 3 })).toEqual(before);
  expect(sibling.entries()).toEqual([row("one", 9, 1)]);
  restorePruning();
  const value = { value: 3 };
  const pending = register("three", value, 1);
  value.value = 99;
  await pending;
  expect(store.latest({ limit: 3 })).toEqual([row("three", 3, 1, 3), before[0]]);
  expect(sibling.entries()).toEqual([row("one", 9, 1)]);
});

it("reads bounded newest-first pages by sequence", async () => {
  const { store } = fixture("latest-test", 10);
  store.register("one", { value: 1 }, 100);
  store.register("two", { value: 2 }, 100);
  store.register("three", { value: 3 }, 50);

  const firstPage = store.latest({ limit: 2 });
  expect(firstPage.map((entry) => entry.key)).toEqual(["three", "two"]);
  expect(firstPage.map((entry) => entry.sequence)).toEqual([3, 2]);
  expect(store.latest({ limit: 2, beforeSequence: firstPage.at(-1)!.sequence })).toEqual([
    expect.objectContaining({ key: "one", sequence: 1 }),
  ]);
  expect(store.latest({ limit: 0 })).toEqual([]);
});

it("prunes a legacy batch with one delete while preserving runtime rows and other scopes", async () => {
  const { options, store } = fixture("batch-test", 3);
  const { store: sibling } = fixture("other-scope", 3, options.env);
  store.register("runtime", { value: 100 }, 0);
  sibling.register("legacy-0", { value: 200 }, 1);
  const { db } = openOpenClawStateDatabase(options);
  const compile = vi.spyOn(getNodeSqliteKysely(db).getExecutor(), "compileQuery");

  store.registerLegacyMany(
    Array.from({ length: 50 }, (_, index) => ({
      key: `legacy-${index}`,
      value: { value: index },
      createdAt: 100 - index,
    })),
  );

  expect(store.entries().map((entry) => entry.key)).toEqual(["legacy-48", "legacy-49", "runtime"]);
  expect(sibling.entries()).toEqual([row("legacy-0", 200, 1)]);
  expect(
    compile.mock.results.filter(
      (result) => result.type === "return" && DeleteQueryNode.is(result.value.query),
    ),
  ).toHaveLength(1);
});

it.each(["register", "upsert", "compareAndSet"] as const)(
  "protects the oldest key during %s without changing its insertion age",
  async (operation) => {
    const { options, store, write } = fixture("protected-test", 2);
    const { store: seed } = fixture("protected-test", 4, options.env);
    for (const [index, key] of ["old\0key", "second", "third", "newest"].entries()) {
      seed.register(key, { value: index }, 1);
    }
    if (operation === "compareAndSet") {
      const writer = write();
      await expect(writer.compareAndSet("old\0key", { value: 0 }, { value: 9 }, 0)).resolves.toBe(
        true,
      );
    } else {
      store[operation]("old\0key", { value: 9 }, 0);
    }
    expect(store.latest({ limit: 4 })).toEqual([
      row("newest", 3, 1, 4),
      row("old\0key", operation === "register" ? 0 : 9, operation === "register" ? 1 : 0, 1),
    ]);
  },
);

it("rolls back failed pruning and lets a caller-owned transaction continue", async () => {
  const { options, store } = fixture("rollback-test", 2);
  store.register("one", { value: 1 }, 1);
  store.register("two", { value: 2 }, 2);
  const before = store.latest({ limit: 3 });
  const restorePruning = rejectPruning(options, "audit pruning refused", true);
  const append = () => store.register("three", { value: 3 }, 3);
  expect(append).toThrow("audit pruning refused");
  expect(store.latest({ limit: 3 })).toEqual(before);

  runOpenClawStateWriteTransaction(() => {
    expect(append).toThrow("audit pruning refused");
    store.upsert("two", { value: 20 }, 20);
  }, options);
  expect(store.latest({ limit: 3 })).toEqual([row("two", 20, 20, 2), before[1]]);
  restorePruning();
  append();
  expect(store.entries().map((entry) => entry.key)).toEqual(["two", "three"]);
});

it("keeps keyed mutations atomic without changing insertion age", async () => {
  const { store, write } = fixture("upsert-test", 2);
  const writer = write();

  store.register("one", { value: 1 }, 1);
  store.register("two", { value: 2 }, 2);
  store.upsert("one", { value: 3 }, 3);
  expectLatest(store, [row("two", 2, 2, 2), row("one", 3, 3, 1)]);

  await expect(writer.compareAndSet("one", { value: 3 }, { value: 4 }, 4)).resolves.toBe(true);
  expectLatest(store, [row("two", 2, 2, 2), row("one", 4, 4, 1)]);

  await expect(writer.compareAndSet("one", { value: 999 }, null)).resolves.toBe(false);
  expectLatest(store, [row("two", 2, 2, 2), row("one", 4, 4, 1)]);

  await expect(writer.compareAndSet("one", { value: 4 }, null)).resolves.toBe(true);
  await expect(writer.compareAndSet("three", null, { value: 5 }, 5)).resolves.toBe(true);
  expectLatest(store, [row("three", 5, 5, 3), row("two", 2, 2, 2)]);

  await expect(writer.compareAndSet("four", null, { value: 6 }, 6)).resolves.toBe(true);
  expectLatest(store, [row("four", 6, 6, 4), row("three", 5, 5, 3)]);
});
