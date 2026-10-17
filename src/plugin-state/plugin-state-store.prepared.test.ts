import { describe, expect, it, vi } from "vitest";
import { getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db-cache.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { useState } from "./plugin-state-fixtures.test-support.js";
import {
  createPluginStateSyncKeyedStore,
  importPluginStateEntriesForDoctor,
} from "./plugin-state-store.js";
import { lookupPluginStateEntry } from "./plugin-state-store.kernel.js";
import { registerPluginStateEntry } from "./plugin-state-store.retention.js";
import { closePluginStateDatabase } from "./plugin-state-store.sqlite.js";
import { seedPluginStateEntriesForTests } from "./plugin-state-store.test-helpers.js";

describe("plugin-state-store.import", () => {
  const testState = useState("plugin-state-import", true, true);
  const pluginId = "import-test";
  const importOptions = { namespace: "legacy", maxEntries: 2_000 };
  const open = () => createPluginStateSyncKeyedStore(pluginId, importOptions);
  const entries = Array.from({ length: 1_001 }, (_, index) => ({
    key: `row-${index}`,
    value: index,
    createdAt: index - 2_000,
  }));
  const importRows = (rows = entries) =>
    importPluginStateEntriesForDoctor(pluginId, importOptions, rows);

  it("preserves a transaction-abort failure and reopens without committing its batch prefix", () => {
    const db = openOpenClawStateDatabase().db;
    db.exec(`CREATE TEMP TRIGGER abort_import BEFORE INSERT ON plugin_state_entries
      WHEN NEW.entry_key = 'row-750' BEGIN SELECT RAISE(ROLLBACK, 'import transaction aborted'); END`);
    expect(() => importRows()).toThrow(
      expect.objectContaining({
        code: "PLUGIN_STATE_WRITE_FAILED",
        cause: expect.objectContaining({ message: "import transaction aborted" }),
      }),
    );
    expect(db.isOpen).toBe(false);
    const reopened = openOpenClawStateDatabase().db;
    expect(reopened === db).toBe(false);
    const store = open();
    // The first bounded batch committed; the entire second batch was aborted.
    expect(store.entries()).toEqual(entries.slice(0, 500));
    importRows();
    expect(store.entries()).toEqual(entries);
  });

  it("refreshes namespace retention when the clock advances during import", () => {
    let clock = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    seedPluginStateEntriesForTests([
      {
        pluginId,
        namespace: importOptions.namespace,
        key: "expiring",
        value: true,
        expiresAt: 10_001,
      },
    ]);
    const db = requireNativeSqliteDatabase(openOpenClawStateDatabase().db);
    db.function("advance_import_clock", () => {
      clock = 10_001;
      return 0;
    });
    db.exec(`CREATE TEMP TRIGGER advance_clock AFTER INSERT ON plugin_state_entries
      WHEN NEW.entry_key = 'first' BEGIN SELECT advance_import_clock(); END`);
    const limited = { ...importOptions, maxEntries: 2, overflowPolicy: "reject-new" as const };
    const source = [
      { key: "first", value: 1, createdAt: -2 },
      { key: "second", value: 2, createdAt: -1, ttlMs: 100 },
    ];
    importPluginStateEntriesForDoctor(pluginId, limited, source);
    expect(createPluginStateSyncKeyedStore(pluginId, limited).entries()).toEqual([
      source[0],
      { key: "second", value: 2, createdAt: -1, expiresAt: 10_101 },
    ]);
  });

  it("leaves the store empty when the first import entry fails preparation", () => {
    const invalid = entries.map((entry, offset) =>
      offset === 0 ? { ...entry, createdAt: Number.NaN } : entry,
    );
    expect(() => importRows(invalid)).toThrow("createdAt must be a safe integer");
    const store = open();
    expect(store.entries()).toEqual([]);
    importRows();
    expect(store.entries()).toEqual(entries);
  });

  it.each(["evict-oldest", "reject-new"] as const)(
    "preserves %s retention with duplicate keys and durable sibling rows",
    (overflowPolicy) => {
      seedPluginStateEntriesForTests([
        { pluginId, namespace: "durable", key: "sibling", value: true },
      ]);
      const limited = { ...importOptions, maxEntries: 2, overflowPolicy };
      const source = [
        { key: "z", value: 1, createdAt: 20 },
        { key: "a", value: 2, createdAt: 10 },
        { key: "z", value: 3, createdAt: 20 },
        { key: "older", value: 4, createdAt: -10 },
      ];
      if (overflowPolicy === "reject-new") {
        expect(() => importPluginStateEntriesForDoctor(pluginId, limited, source)).toThrow(
          "reached its 2-row limit",
        );
      } else {
        importPluginStateEntriesForDoctor(pluginId, limited, source);
      }
      const store = createPluginStateSyncKeyedStore(pluginId, limited);
      expect(store.entries()).toEqual([source[overflowPolicy === "reject-new" ? 1 : 3], source[2]]);
      expect(
        createPluginStateSyncKeyedStore(pluginId, { namespace: "durable", maxEntries: 1 }).lookup(
          "sibling",
        ),
      ).toBe(true);
    },
  );

  it("uses the supplied connection and keeps registration eviction in its owner's transaction", () => {
    const scope = { pluginId: "discord", namespace: "owned-kernel" };
    const defaultStore = createPluginStateSyncKeyedStore<string>(scope.pluginId, {
      namespace: scope.namespace,
      maxEntries: 1,
    });
    defaultStore.register("original", "default database");
    const pathname = testState().statePath("kernel-owned.sqlite");
    const database = openOpenClawStateDatabase({ path: pathname, env: testState().env });
    const options = { database, env: testState().env };
    const entry = { ...scope, maxEntries: 1, overflowPolicy: "evict-oldest" as const };
    const lookup = (key: string, db = database) => lookupPluginStateEntry(db, { ...scope, key });
    runOpenClawStateWriteTransaction(() => {
      registerPluginStateEntry(database, { ...entry, key: "original", valueJson: '"owned"' });
    }, options);

    const aborted = new Error("abort the caller's transaction");
    expect(() =>
      runOpenClawStateWriteTransaction(() => {
        registerPluginStateEntry(database, { ...entry, key: "pending", valueJson: '"pending"' });
        expect([lookup("pending"), lookup("original")]).toEqual(["pending", undefined]);
        throw aborted;
      }, options),
    ).toThrow(aborted);
    expect([lookup("pending"), lookup("original")]).toEqual([undefined, "owned"]);
    expect(defaultStore.lookup("original")).toBe("default database");
    closeOpenClawStateDatabaseByPath(pathname);
    const reopened = openOpenClawStateDatabase({ path: pathname, env: testState().env });
    expect([lookup("original", reopened), lookup("pending", reopened)]).toEqual([
      "owned",
      undefined,
    ]);
  });

  it.each([
    ["register", "reject-new"],
    ["registerIfAbsent", "evict-oldest"],
  ] as const)(
    "reuses %s %s write and quota compilation with fresh bindings after reopening",
    (operation, overflowPolicy) => {
      const options = { namespace: "prepared-writes", maxEntries: 20, overflowPolicy };
      const stores = [
        createPluginStateSyncKeyedStore<string>("discord", options),
        createPluginStateSyncKeyedStore<string>("telegram", options),
        createPluginStateSyncKeyedStore<string>("discord", {
          ...options,
          namespace: "prepared-sibling",
        }),
      ];
      const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
      for (let connection = 0; connection < 2; connection++) {
        closePluginStateDatabase();
        const { db } = openOpenClawStateDatabase();
        const compile = vi.spyOn(getNodeSqliteKysely(db).getExecutor(), "compileQuery");
        try {
          const key = `round-${connection}`;
          for (const [index, store] of stores.entries()) {
            clock.mockReturnValue(10_000 + index);
            store[operation](key, `value-${index}`, { ttlMs: 100 });
            clock.mockReturnValue(10_010 + index);
            store[operation](`${key}-durable`, `durable-${index}`);
            const result = store[operation](key, `replacement-${index}`);
            if (operation === "registerIfAbsent") {
              expect(result).toBe(false);
            }
            const expected =
              operation === "registerIfAbsent"
                ? {
                    key,
                    value: `value-${index}`,
                    createdAt: 10_000 + index,
                    expiresAt: 10_100 + index,
                  }
                : { key, value: `replacement-${index}`, createdAt: 10_010 + index };
            expect(store.entries().filter((entry) => entry.key.startsWith(key))).toEqual([
              expected,
              { key: `${key}-durable`, value: `durable-${index}`, createdAt: 10_010 + index },
            ]);
          }
          const compiled = (prefix: string) =>
            compile.mock.results.filter(
              (result) => result.type === "return" && result.value.sql.startsWith(prefix),
            );
          expect(compiled("insert")).toHaveLength(1);
          expect(compiled('select count(*) as "count" from "plugin_state_entries"')).toHaveLength(
            1,
          );
        } finally {
          compile.mockRestore();
        }
      }
    },
  );
});
