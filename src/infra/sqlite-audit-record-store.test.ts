import { DeleteQueryNode } from "kysely";
import { describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { getNodeSqliteKysely } from "./kysely-sync.js";
import {
  createSqliteAuditRecordReader,
  createSqliteAuditRecordWriter,
  registerSqliteAuditRecordAsync,
} from "./sqlite-audit-record-store.async.js";
import { createSqliteAuditRecordStore } from "./sqlite-audit-record-store.js";

function withAuditStoreFixture(
  options: { prefix: string },
  run: (stateDir: string) => Promise<void>,
): Promise<void> {
  return withTestDir(options, async (stateDir) => {
    try {
      await run(stateDir);
    } finally {
      vi.restoreAllMocks();
      await closeOpenClawStateDatabaseAsync();
    }
  });
}

describe("SQLite audit record store", () => {
  it("refreshes sequence and retention facts after foreign writes and duplicate legacy rows", async () => {
    await withAuditStoreFixture({ prefix: "openclaw-audit-write-facts-" }, async (stateDir) => {
      const options = {
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        scope: "write-facts",
        maxEntries: 3,
      };
      const native = createSqliteAuditRecordStore<{ value: number }>(options);
      const writer = createSqliteAuditRecordWriter<{ value: number }>(options);
      native.registerLegacyMany([
        { key: "legacy", value: { value: 0 }, createdAt: 0 },
        { key: "legacy", value: { value: 99 }, createdAt: 1 },
      ]);
      await writer.register("first", { value: 1 }, 1);
      native.register("foreign", { value: 2 }, 2);
      await writer.register("second", { value: 3 }, 3);
      expect(native.latest({ limit: 5 })).toEqual([
        { key: "second", value: { value: 3 }, createdAt: 3, sequence: 3 },
        { key: "foreign", value: { value: 2 }, createdAt: 2, sequence: 2 },
        { key: "first", value: { value: 1 }, createdAt: 1, sequence: 1 },
      ]);
      await writer.register("first", { value: 99 }, 99);
      expect(native.entries()).toHaveLength(3);
      await expect(writer.compareAndSet("foreign", { value: 2 }, null)).resolves.toBe(true);
      native.registerLegacyMany([
        { key: "legacy", value: { value: 4 }, createdAt: 4 },
        { key: "legacy", value: { value: 99 }, createdAt: 5 },
      ]);
      await writer.register("third", { value: 5 }, 5);
      expect(native.latest({ limit: 5 })).toEqual([
        { key: "third", value: { value: 5 }, createdAt: 5, sequence: 4 },
        { key: "second", value: { value: 3 }, createdAt: 3, sequence: 3 },
        { key: "first", value: { value: 1 }, createdAt: 1, sequence: 1 },
      ]);
    });
  });

  it("scans older config edits and rejects all facts when a later page is corrupt", async () => {
    await withAuditStoreFixture({ prefix: "openclaw-audit-facts-scan-" }, async (stateDir) => {
      const options = {
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        scope: "config-audit",
        maxEntries: 10,
      };
      const native = createSqliteAuditRecordStore<{ event: string }>(options);
      native.register("old-external", { event: "config.external" }, 1);
      for (let sequence = 2; sequence <= 8; sequence += 1) {
        native.register(`write-${sequence}`, { event: "config.write" }, sequence);
      }
      const reader = createSqliteAuditRecordReader<{ event: string }>(options);

      await expect(reader.configAuditFacts(0)).resolves.toEqual({
        auditSequence: 8,
        recentExternalEdit: true,
      });
      await expect(reader.configAuditFacts(1)).resolves.toEqual({
        auditSequence: 8,
        recentExternalEdit: false,
      });

      native.upsert("write-8", { event: "config.external" }, 8);
      const { db } = openOpenClawStateDatabase(options);
      db.prepare(
        "UPDATE diagnostic_events SET payload_json = ? WHERE scope = ? AND event_key = ?",
      ).run("{", options.scope, "old-external");

      await expect(reader.configAuditFacts(0)).rejects.toThrow(/JSON|Unexpected|property name/i);
      await expect(reader.configAuditFacts(5)).resolves.toEqual({
        auditSequence: 8,
        recentExternalEdit: true,
      });
    });
  });

  it("settles competing worker comparisons against current rows and captures submitted values", async () => {
    await withAuditStoreFixture({ prefix: "openclaw-audit-cas-" }, async (stateDir) => {
      const options = {
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        scope: "greeting-cas",
        maxEntries: 1,
      };
      const native = createSqliteAuditRecordStore<{ text: string; cursor: number }>(options);
      native.register("latest", { text: "initial", cursor: 0 }, 1);
      const firstWriter = createSqliteAuditRecordWriter<{ text: string; cursor: number }>(options);
      const secondWriter = createSqliteAuditRecordWriter<{ text: string; cursor: number }>(options);
      const reader = createSqliteAuditRecordReader<{ text: string; cursor: number }>(options);
      expect((await reader.latest({ limit: 1 }))[0]?.value).toEqual({ text: "initial", cursor: 0 });

      const expected = { text: "initial", cursor: 0 };
      const replacement = { text: "greeting", cursor: 0 };
      const first = firstWriter.compareAndSet("latest", expected, replacement, 2);
      const second = secondWriter.compareAndSet(
        "latest",
        { text: "initial", cursor: 0 },
        { text: "initial", cursor: 7 },
        3,
      );
      expected.cursor = 99;
      replacement.text = "mutated after submission";

      await expect(Promise.all([first, second])).resolves.toEqual([true, false]);
      expect((await reader.latest({ limit: 1 }))[0]).toMatchObject({
        value: { text: "greeting", cursor: 0 },
        createdAt: 2,
        sequence: 1,
      });

      native.upsert("latest", { text: "foreign commit", cursor: 8 }, 4);
      expect((await reader.latest({ limit: 1 }))[0]?.value).toEqual({
        text: "foreign commit",
        cursor: 8,
      });
      await expect(
        secondWriter.compareAndSet(
          "latest",
          { text: "foreign commit", cursor: 8 },
          { text: "next greeting", cursor: 8 },
          5,
        ),
      ).resolves.toBe(true);
      expect(native.latest({ limit: 1 })[0]?.value).toEqual({ text: "next greeting", cursor: 8 });
    });
  });

  it("rolls back async insertion and retention together, preserving sibling scopes", async () => {
    await withAuditStoreFixture({ prefix: "openclaw-async-audit-rollback-" }, async (stateDir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const options = { env, scope: "async-rollback", maxEntries: 2 };
      const store = createSqliteAuditRecordStore<{ value: number }>(options);
      const sibling = createSqliteAuditRecordStore<{ value: number }>({
        ...options,
        scope: "sibling",
      });
      store.register("one", { value: 1 }, 3);
      store.register("two", { value: 2 }, 2);
      sibling.register("one", { value: 9 }, 1);
      const before = store.latest({ limit: 3 });
      // Admit the worker before installing a cross-connection transaction fault.
      await registerSqliteAuditRecordAsync(options, {
        key: "two",
        value: { value: 2 },
        createdAt: 2,
      });
      const { db } = openOpenClawStateDatabase({ env });
      db.exec(`
        CREATE TRIGGER reject_async_audit_pruning BEFORE DELETE ON diagnostic_events
        WHEN OLD.scope = 'async-rollback' AND OLD.event_key = 'one'
        BEGIN SELECT RAISE(ABORT, 'async audit pruning refused'); END;
      `);
      await expect(
        registerSqliteAuditRecordAsync(options, {
          key: "three",
          value: { value: 3 },
          createdAt: 1,
        }),
      ).rejects.toThrow("async audit pruning refused");
      expect(store.latest({ limit: 3 })).toEqual(before);
      expect(sibling.entries()).toEqual([{ key: "one", value: { value: 9 }, createdAt: 1 }]);
      db.exec("DROP TRIGGER reject_async_audit_pruning");
      const value = { value: 3 };
      const pending = registerSqliteAuditRecordAsync(options, {
        key: "three",
        value,
        createdAt: 1,
      });
      value.value = 99;
      await pending;
      expect(store.latest({ limit: 3 })).toEqual([
        { key: "three", value: { value: 3 }, createdAt: 1, sequence: 3 },
        before[0],
      ]);
      expect(sibling.entries()).toEqual([{ key: "one", value: { value: 9 }, createdAt: 1 }]);
    });
  });

  it("reads bounded newest-first pages by sequence", async () => {
    await withAuditStoreFixture({ prefix: "openclaw-audit-store-latest-" }, async (stateDir) => {
      const store = createSqliteAuditRecordStore<{ value: number }>({
        scope: "latest-test",
        maxEntries: 10,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });

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
  });

  it("preserves insertion order and prunes the oldest row when timestamps tie", async () => {
    await withAuditStoreFixture({ prefix: "openclaw-audit-store-ties-" }, async (stateDir) => {
      const store = createSqliteAuditRecordStore<{ value: number }>({
        scope: "tied-timestamps",
        maxEntries: 2,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });

      store.register("z-first", { value: 1 }, 1);
      store.register("a-second", { value: 2 }, 1);
      expect(store.entries().map((entry) => entry.key)).toEqual(["z-first", "a-second"]);

      store.register("m-third", { value: 3 }, 1);
      expect(store.entries().map((entry) => entry.key)).toEqual(["a-second", "m-third"]);
    });
  });

  it("prunes by insertion order when wall-clock timestamps move", async () => {
    await withAuditStoreFixture(
      { prefix: "openclaw-audit-store-clock-skew-" },
      async (stateDir) => {
        const store = createSqliteAuditRecordStore<{ value: number }>({
          scope: "clock-skew",
          maxEntries: 2,
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        });

        store.register("future-first", { value: 1 }, 4_000_000_000_000);
        store.register("past-second", { value: 2 }, 1);
        store.register("current-third", { value: 3 }, 2_000_000_000_000);

        expect(store.entries().map((entry) => entry.key)).toEqual(["past-second", "current-third"]);
      },
    );
  });

  it("prunes a legacy batch with one delete while preserving runtime rows and other scopes", async () => {
    await withAuditStoreFixture({ prefix: "openclaw-audit-store-batch-" }, async (stateDir) => {
      const options = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
      const store = createSqliteAuditRecordStore<{ value: number }>({
        ...options,
        scope: "batch-test",
        maxEntries: 3,
      });
      const sibling = createSqliteAuditRecordStore<{ value: number }>({
        ...options,
        scope: "other-scope",
        maxEntries: 3,
      });
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

      expect(store.entries().map((entry) => entry.key)).toEqual([
        "legacy-48",
        "legacy-49",
        "runtime",
      ]);
      expect(sibling.entries()).toEqual([{ key: "legacy-0", value: { value: 200 }, createdAt: 1 }]);
      expect(
        compile.mock.results.filter(
          (result) => result.type === "return" && DeleteQueryNode.is(result.value.query),
        ),
      ).toHaveLength(1);
    });
  });

  it.each(["register", "upsert", "compareAndSet"] as const)(
    "protects the oldest key during %s without changing its insertion age",
    async (operation) => {
      await withAuditStoreFixture(
        { prefix: "openclaw-audit-store-protected-" },
        async (stateDir) => {
          const options = {
            scope: "protected-test",
            env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
          };
          const seed = createSqliteAuditRecordStore<{ value: number }>({
            ...options,
            maxEntries: 4,
          });
          for (const [index, key] of ["old\0key", "second", "third", "newest"].entries()) {
            seed.register(key, { value: index }, 1);
          }
          const store = createSqliteAuditRecordStore<{ value: number }>({
            ...options,
            maxEntries: 2,
          });
          if (operation === "compareAndSet") {
            const writer = createSqliteAuditRecordWriter<{ value: number }>({
              ...options,
              maxEntries: 2,
            });
            await expect(
              writer.compareAndSet("old\0key", { value: 0 }, { value: 9 }, 0),
            ).resolves.toBe(true);
          } else {
            store[operation]("old\0key", { value: 9 }, 0);
          }
          expect(store.latest({ limit: 4 })).toEqual([
            { key: "newest", value: { value: 3 }, createdAt: 1, sequence: 4 },
            {
              key: "old\0key",
              value: { value: operation === "register" ? 0 : 9 },
              createdAt: operation === "register" ? 1 : 0,
              sequence: 1,
            },
          ]);
        },
      );
    },
  );

  it("rolls back failed pruning and lets a caller-owned transaction continue", async () => {
    await withAuditStoreFixture({ prefix: "openclaw-audit-store-rollback-" }, async (stateDir) => {
      const options = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
      const store = createSqliteAuditRecordStore<{ value: number }>({
        ...options,
        scope: "rollback-test",
        maxEntries: 2,
      });
      store.register("one", { value: 1 }, 1);
      store.register("two", { value: 2 }, 2);
      const before = store.latest({ limit: 3 });
      const { db } = openOpenClawStateDatabase(options);
      db.exec(`
        CREATE TEMP TRIGGER reject_audit_pruning BEFORE DELETE ON diagnostic_events
        WHEN OLD.scope = 'rollback-test' AND OLD.event_key = 'one'
        BEGIN SELECT RAISE(ABORT, 'audit pruning refused'); END;
      `);
      const append = () => store.register("three", { value: 3 }, 3);
      expect(append).toThrow("audit pruning refused");
      expect(store.latest({ limit: 3 })).toEqual(before);

      runOpenClawStateWriteTransaction(() => {
        expect(append).toThrow("audit pruning refused");
        store.upsert("two", { value: 20 }, 20);
      }, options);
      expect(store.latest({ limit: 3 })).toEqual([
        { key: "two", value: { value: 20 }, createdAt: 20, sequence: 2 },
        before[1],
      ]);
      db.exec("DROP TRIGGER reject_audit_pruning");
      append();
      expect(store.entries().map((entry) => entry.key)).toEqual(["two", "three"]);
    });
  });

  it("keeps keyed mutations atomic without changing insertion age", async () => {
    await withAuditStoreFixture({ prefix: "openclaw-audit-store-upsert-" }, async (stateDir) => {
      const options = {
        scope: "upsert-test",
        maxEntries: 2,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      };
      const store = createSqliteAuditRecordStore<{ value: number }>(options);
      const writer = createSqliteAuditRecordWriter<{ value: number }>(options);

      store.register("one", { value: 1 }, 1);
      store.register("two", { value: 2 }, 2);
      store.upsert("one", { value: 3 }, 3);
      expect(store.latest({ limit: 2 })).toEqual([
        { key: "two", value: { value: 2 }, createdAt: 2, sequence: 2 },
        { key: "one", value: { value: 3 }, createdAt: 3, sequence: 1 },
      ]);

      await expect(writer.compareAndSet("one", { value: 3 }, { value: 4 }, 4)).resolves.toBe(true);
      expect(store.latest({ limit: 2 })).toEqual([
        { key: "two", value: { value: 2 }, createdAt: 2, sequence: 2 },
        { key: "one", value: { value: 4 }, createdAt: 4, sequence: 1 },
      ]);

      await expect(writer.compareAndSet("one", { value: 999 }, null)).resolves.toBe(false);
      expect(store.latest({ limit: 2 })).toEqual([
        { key: "two", value: { value: 2 }, createdAt: 2, sequence: 2 },
        { key: "one", value: { value: 4 }, createdAt: 4, sequence: 1 },
      ]);

      await expect(writer.compareAndSet("one", { value: 4 }, null)).resolves.toBe(true);
      await expect(writer.compareAndSet("three", null, { value: 5 }, 5)).resolves.toBe(true);
      expect(store.latest({ limit: 2 })).toEqual([
        { key: "three", value: { value: 5 }, createdAt: 5, sequence: 3 },
        { key: "two", value: { value: 2 }, createdAt: 2, sequence: 2 },
      ]);

      await expect(writer.compareAndSet("four", null, { value: 6 }, 6)).resolves.toBe(true);
      expect(store.latest({ limit: 2 })).toEqual([
        { key: "four", value: { value: 6 }, createdAt: 6, sequence: 4 },
        { key: "three", value: { value: 5 }, createdAt: 5, sequence: 3 },
      ]);
    });
  });
});
