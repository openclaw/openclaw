import { chmodSync, existsSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runInNewContext } from "node:vm";
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { ok } from "@openclaw/normalization-core/result";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { clearOpenClawDatabaseQuarantine } from "../state/openclaw-quarantine-store.js";
import { seedOpenClawDatabaseQuarantine } from "../state/openclaw-quarantine-store.test-support.js";
import {
  closeOpenClawStateDatabaseByPath,
  openClawStateDatabaseCache,
  recordOpenClawStateDatabaseOpenFailure,
} from "../state/openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { admitStateSchemaFacts } from "../state/openclaw-state-db-schema-version.js";
import {
  isOpenClawStateDatabaseOpen,
  openOpenClawStateDatabase,
  clearOpenClawStateDatabaseOpenFailure,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { claimOpenClawStateOwnership } from "../state/openclaw-state-ownership-operations.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { keyedStore, keyedStores, useState } from "./plugin-state-fixtures.test-support.js";
import {
  runWriteTransaction,
  withPluginStateDatabaseReadOnly,
} from "./plugin-state-store.database.js";
import {
  getPluginStateCapacity,
  registerPluginStateSequencedJournalEntry,
  createCorePluginStateKeyedStore,
  createCorePluginStateKeyedStoreV2,
  createCorePluginStateSyncKeyedStore,
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
  pluginStateEntriesInKeyRange,
  MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES,
  pluginStateDeleteEntriesIfUnchanged,
  pluginStateDoctorEntriesInKeyRange,
  resetPluginStateStoreForTests,
  type OpenKeyedStoreOptions,
} from "./plugin-state-store.js";
import { PLUGIN_STATE_EXPIRY_BATCH_ROWS } from "./plugin-state-store.kernel.js";
import {
  readPluginStateRetention,
  registerPluginStateEntry,
} from "./plugin-state-store.retention.js";
import { closePluginStateDatabase } from "./plugin-state-store.sqlite.js";
import { seedPluginStateEntriesForTests } from "./plugin-state-store.test-helpers.js";
import { PluginStateStoreError } from "./plugin-state-store.types.js";

type SeedRow = Parameters<typeof seedPluginStateEntriesForTests>[0][number];
type ScopedSeedRow = Pick<SeedRow, "key" | "value"> & Partial<SeedRow>;
const seedScope = (pluginId: string, namespace: string, rows: ScopedSeedRow[]) =>
  seedPluginStateEntriesForTests(rows.map((row) => ({ pluginId, namespace, ...row })));
const entryOf = <T>(key: string, value: T, createdAt: number) => ({ key, value, createdAt });

const defaults = { namespace: "test", maxEntries: 10 };
function syncStore<T>(options: Partial<OpenKeyedStoreOptions> = {}, pluginId = "discord") {
  return createPluginStateSyncKeyedStore<T>(pluginId, { ...defaults, ...options });
}
function openAsyncStore<T>(options: Partial<OpenKeyedStoreOptions> = {}, pluginId = "discord") {
  return createPluginStateKeyedStore<T>(pluginId, { ...defaults, ...options });
}
function stores<T>(options: Partial<OpenKeyedStoreOptions>, pluginId = "discord") {
  return keyedStores<T>(pluginId, { ...defaults, ...options });
}
function throws(action: () => unknown, expected: object) {
  expect(action).toThrowError(expect.objectContaining(expected));
}
function maintenance(namespace: string) {
  const scope = { pluginId: "codex", namespace };
  return {
    seed: (rows: ScopedSeedRow[]) => seedScope(scope.pluginId, namespace, rows),
    page: (limit: number, after?: string) =>
      pluginStateDoctorEntriesInKeyRange({ ...scope, prefix: "binding:", limit, after }),
    remove: (
      entries: Parameters<typeof pluginStateDeleteEntriesIfUnchanged>[0]["entries"],
      assertOwnedInTransaction = (_database: EngineConnection) => {},
    ) => pluginStateDeleteEntriesIfUnchanged({ ...scope, entries, assertOwnedInTransaction }),
    range: () =>
      pluginStateEntriesInKeyRange({
        ...scope,
        keyStartInclusive: "binding:",
        keyEndExclusive: "binding;",
        limit: 1,
      }),
  };
}

describe("plugin-state-store", () => {
  const testState = useState("plugin-state-store");
  beforeAll(() => {
    rmSync(dirname(resolveOpenClawStateSqlitePath()), { recursive: true, force: true });
  });

  const expectPluginStateStoreError = (
    promise: Promise<unknown>,
    code: string,
    operation?: string,
  ) => expect(promise).rejects.toMatchObject({ code, ...(operation ? { operation } : {}) });

  it("round-trips nested VM realm values across store instances", async () => {
    const options = { namespace: "components", maxEntries: 10 };
    const store = openAsyncStore(options);
    const value: unknown = runInNewContext(
      '({ nested: [{ count: 1, labels: ["retained", null] }] })',
    );
    await store.register("interaction:1", value);
    if (process.platform !== "win32") {
      const databasePath = resolveOpenClawStateSqlitePath();
      expect(statSync(dirname(databasePath)).mode & 0o777).toBe(0o700);
      expect(statSync(databasePath).mode & 0o777).toBe(0o600);
    }
    closePluginStateDatabase();

    const reopened = syncStore(options);
    expect(reopened.lookup("interaction:1")).toEqual({
      nested: [{ count: 1, labels: ["retained", null] }],
    });
  });

  it("updates a key from the current stored value", async () => {
    const store = syncStore<{ count: number }>();
    const update = store.update;

    expect(update("counter", (current) => ({ count: (current?.count ?? 0) + 1 }))).toBe(true);
    expect(update("counter", (current) => ({ count: (current?.count ?? 0) + 1 }))).toBe(true);
    expect(update("counter", () => undefined)).toBe(false);
    expect(store.lookup("counter")).toEqual({ count: 2 });
  });

  it("rejects new durable rows at capacity without evicting or blocking updates", async () => {
    vi.useFakeTimers();
    const store = syncStore<number>(
      { namespace: "durable-bindings", maxEntries: 2, overflowPolicy: "reject-new" },
      "codex",
    );
    vi.setSystemTime(1000);
    expect(store.registerIfAbsent("first", 1)).toBe(true);
    vi.setSystemTime(2000);
    expect(store.registerIfAbsent("second", 2)).toBe(true);

    const limit = { code: "PLUGIN_STATE_LIMIT_EXCEEDED", operation: "register" };
    throws(() => store.register("third", 3), limit);
    expect(store.registerIfAbsent("first", 99)).toBe(false);
    vi.setSystemTime(3000);
    expect(store.update("first", () => 10)).toBe(true);
    throws(() => store.update("third", () => 3), limit);
    expect(store.entries()).toEqual([
      expect.objectContaining({ key: "second", value: 2 }),
      expect.objectContaining({ key: "first", value: 10 }),
    ]);
  });

  it("deletes an entry only when the current value matches", async () => {
    const store = openAsyncStore<{ version: number }>();
    await store.register("chat", { version: 1 });

    await expect(store.deleteIf("chat", (current) => current.version === 2)).resolves.toBe(false);
    await expect(store.lookup("chat")).resolves.toEqual({ version: 1 });
    await expect(store.deleteIf("chat", (current) => current.version === 1)).resolves.toBe(true);
    await expect(store.lookup("chat")).resolves.toBeUndefined();
  });

  it("rejects plugin state ttl when expiry cannot fit in a Date timestamp", async () => {
    const store = openAsyncStore();

    await expectPluginStateStoreError(
      store.register("huge", true, { ttlMs: Number.MAX_VALUE }),
      "PLUGIN_STATE_INVALID_INPUT",
      "register",
    );

    vi.spyOn(Date, "now").mockReturnValue(MAX_DATE_TIMESTAMP_MS);
    const sync = syncStore();
    throws(() => sync.register("overflow", true, { ttlMs: 60_000 }), {
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation: "register",
    });
  });

  it("validates namespaces, keys, options, and JSON values before writes", async () => {
    for (const options of [
      { namespace: "../bad" },
      { maxEntries: 0 },
      { namespace: "a".repeat(129) },
    ]) {
      expect(() => openAsyncStore(options)).toThrow(PluginStateStoreError);
    }

    const store = openAsyncStore({ namespace: "valid", maxEntries: 10 });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const sparse: unknown[] = [];
    sparse[1] = "hole";
    const nonEnumerable = { visible: true };
    Object.defineProperty(nonEnumerable, "hidden", { value: true, enumerable: false });
    for (const [key, value] of Object.entries({
      " ": true,
      undefined,
      infinity: Infinity,
      circular,
      sparse,
      date: new Date(),
      map: new Map([["k", "v"]]),
      "non-enumerable": nonEnumerable,
    })) {
      await expect(store.register(key, value), key).rejects.toThrow(PluginStateStoreError);
    }

    await expect(store.register("k".repeat(513), true)).rejects.toThrow(PluginStateStoreError);

    let deep: unknown = { leaf: true };
    for (let i = 0; i < 65; i += 1) {
      deep = { nested: deep };
    }
    await expectPluginStateStoreError(store.register("deep", deep), "PLUGIN_STATE_LIMIT_EXCEEDED");

    await expectPluginStateStoreError(store.lookup(" "), "PLUGIN_STATE_INVALID_INPUT", "lookup");
    await expectPluginStateStoreError(store.delete(" "), "PLUGIN_STATE_INVALID_INPUT", "delete");
  });

  it("enforces the 1 MiB boundary across writes", async () => {
    const store = openAsyncStore<string>();
    const boundary = "é".repeat(524_287);
    const oversize = `${boundary}x`;
    await store.register("registered", boundary);
    expect(await store.registerIfAbsent("claimed", boundary)).toBe(true);
    await store.register("updated", "before");
    expect(await store.update("updated", () => boundary)).toBe(true);

    for (const write of [
      () => store.register("registered", oversize),
      () => store.registerIfAbsent("rejected", oversize),
      () => store.update("updated", () => oversize),
    ]) {
      await expect(write()).rejects.toMatchObject({ code: "PLUGIN_STATE_LIMIT_EXCEEDED" });
    }
    resetPluginStateStoreForTests();
    for (const key of ["registered", "claimed", "updated"]) {
      expect(await store.lookup(key)).toBe(boundary);
    }
    expect(await store.lookup("rejected")).toBeUndefined();
  });

  it("allows core owners and reserves core-prefixed plugin ids", async () => {
    const key = "telegram:personal";
    const options = {
      ownerId: "core:channel-intent" as const,
      namespace: "stopped",
      maxEntries: 10,
    };
    const store = createCorePluginStateSyncKeyedStore<{ stopped: boolean }>(options);
    const asyncStore = createCorePluginStateKeyedStore<{ stopped: boolean }>(options);
    const workerStore = createCorePluginStateKeyedStoreV2<{ stopped: boolean }>(options, {
      assertCurrent: () => {},
    });
    expect(store.update(key, () => ({ stopped: true }))).toBe(true);
    closePluginStateDatabase();
    await expect(asyncStore.lookup(key)).resolves.toEqual({ stopped: true });
    const observation = await workerStore.observe(key);
    store.register(key, { stopped: false });
    await expect(
      workerStore.compareAndApply(key, observation.comparison, {
        operation: "delete",
        action: "delete",
      }),
    ).resolves.toMatchObject({ status: "conflict" });
    await expect(workerStore.lookup(key)).resolves.toEqual({ stopped: false });
    expect(() => createCorePluginStateKeyedStore({ ...options, maxEntries: 11 })).toThrow(
      PluginStateStoreError,
    );
    expect(() => keyedStore("core:not-a-plugin", "bad")).toThrow(PluginStateStoreError);
  });

  it("treats a missing plugin-state database as empty without creating it", async () => {
    await withOpenClawTestState(
      { label: "plugin-state-read-only-missing", applyEnv: false },
      async (state) => {
        const store = openAsyncStore({ env: state.env });
        const databasePath = resolveOpenClawStateSqlitePath(state.env);

        expect(existsSync(databasePath)).toBe(false);
        await expect(store.lookup("k")).resolves.toBeUndefined();
        await expect(store.lookupMany(["k", "missing"])).resolves.toEqual(
          [undefined, undefined].map(ok),
        );
        await expect(store.lookupMany([])).resolves.toEqual([]);
        await expect(store.entries()).resolves.toEqual([]);
        await expect(store.count()).resolves.toBe(0);
        expect(getPluginStateCapacity("discord", state.env).liveEntries).toBe(0);
        expect(existsSync(databasePath)).toBe(false);
      },
    );
  });

  it.runIf(process.platform !== "win32").each(["database", "ownership"] as const)(
    "handles an inaccessible %s directory without closing the retained connection",
    async (scope) => {
      const store = openAsyncStore();
      await store.register("k", { ok: true });
      const database = openOpenClawStateDatabase();
      const directory = scope === "database" ? dirname(database.path) : testState().stateDir;
      chmodSync(directory, 0o000);
      try {
        if (scope === "database") {
          await expect(store.lookup("k")).resolves.toEqual({ ok: true });
        } else {
          await expect(store.lookup("k")).rejects.toMatchObject({
            code: "PLUGIN_STATE_READ_FAILED",
            cause: expect.objectContaining({ message: expect.stringContaining("ownership") }),
          });
        }
        expect(database.db.isOpen).toBe(true);
      } finally {
        chmodSync(directory, 0o700);
      }
    },
  );

  it("bulk reads exact keys positionally with sync/async parity across reopen", async () => {
    const options = { namespace: "bulk", maxEntries: 20 };
    const { sync, store } = stores<{ index: number }>(options);
    const keys = [
      "ten:10",
      "two:2",
      "nul\0tail",
      "literal\\u0000",
      "lone\ud800",
      "__proto__",
    ] as const;
    keys.forEach((key, index) => sync.register(key, { index }));
    createPluginStateSyncKeyedStore("telegram", options).register(keys[0], { index: 99 });
    syncStore({ ...options, namespace: "other" }).register(keys[0], { index: 98 });
    const now = Date.now();
    seedPluginStateEntriesForTests([
      { pluginId: "discord", namespace: "bulk", key: "expired", value: {}, expiresAt: now },
    ]);
    const request = [keys[3], "missing", keys[0], "expired", ...keys, ` ${keys[1]} `];
    const expected = [
      { index: 3 },
      undefined,
      { index: 0 },
      undefined,
      ...keys.map((_, index) => ({ index })),
      { index: 1 },
    ];
    for (let connection = 0; connection < 2; connection++) {
      expect(sync.lookupMany(request)).toEqual(expected.map(ok));
      await expect(store.lookupMany(request)).resolves.toEqual(expected.map(ok));
      for (const duplicates of [
        sync.lookupMany([keys[0], keys[0]]),
        await store.lookupMany([keys[0], keys[0]]),
      ]) {
        expect(duplicates[0]?.ok && duplicates[0].value).not.toBe(
          duplicates[1]?.ok && duplicates[1].value,
        );
      }
      if (connection > 0) {
        expect(isOpenClawStateDatabaseOpen()).toBe(false);
      }
      closePluginStateDatabase();
    }
    expect(isOpenClawStateDatabaseOpen()).toBe(false);
  });

  it("bounds and validates every bulk key before reading, with one native query", async () => {
    const { sync, store } = stores<number>({ namespace: "bulk-bounds" });
    sync.register("key", 1);
    const db = requireNativeSqliteDatabase(openOpenClawStateDatabase().db);
    const reads = trackSqliteStatementExecutions(db, ["reads"], (sql) =>
      sql.startsWith("select ") && sql.includes('"plugin_state_entries"') ? "reads" : null,
    );
    try {
      expect(sync.lookupMany([])).toEqual([]);
      expect(() => sync.lookupMany(["key", " "])).toThrowError(
        expect.objectContaining({ code: "PLUGIN_STATE_INVALID_INPUT", operation: "lookup" }),
      );
      await expect(
        store.lookupMany(Array.from({ length: 10_001 }, () => "key")),
      ).rejects.toMatchObject({ code: "PLUGIN_STATE_INVALID_INPUT", operation: "lookup" });
      expect(reads.counts.reads).toBe(0);
      expect(sync.lookupMany(Array.from({ length: 10_000 }, () => "key"))).toEqual(
        Array.from({ length: 10_000 }, () => ok(1)),
      );
      expect(reads).toMatchObject({ counts: { reads: 1 }, rowCounts: { reads: 1 } });
    } finally {
      reads.restore();
    }
  });

  it("bulk-deletes only unchanged scoped rows in one bounded transaction", () => {
    const namespace = "bulk-bindings";
    const { seed, page, remove } = maintenance(namespace);
    seed([
      ...Array.from({ length: MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES }, (_, index) => ({
        key: `binding:${String(index).padStart(4, "0")}`,
        value: { generation: 1 },
      })),
      { pluginId: "codex", namespace: "other", key: "binding:0000", value: { keep: true } },
      { pluginId: "other", namespace, key: "binding:0000", value: { keep: true } },
    ]);
    const observed = page(MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES);
    const store = syncStore<{ generation: number }>(
      { namespace, maxEntries: MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES },
      "codex",
    );
    store.register("binding:0000", { generation: 2 });
    const ownerAssertions: boolean[] = [];
    const assertOwnedInTransaction = (database: EngineConnection) => {
      ownerAssertions.push(database.isTransaction);
    };
    expect(remove(observed, assertOwnedInTransaction)).toEqual({
      deleted: MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES - 1,
      changed: 1,
    });
    expect(ownerAssertions).toEqual([true]);
    expect(store.lookup("binding:0000")).toEqual({ generation: 2 });
    for (const [pluginId, retainedNamespace] of [
      ["codex", "other"],
      ["other", namespace],
    ]) {
      expect(
        syncStore({ namespace: retainedNamespace, maxEntries: 1 }, pluginId).lookup("binding:0000"),
      ).toEqual({ keep: true });
    }
    expect(() => remove([...observed, observed[0]!], assertOwnedInTransaction)).toThrow(
      /cannot exceed 512 entries/,
    );
  });

  it("pages past malformed rows and compares siblings' original JSON bytes", async () => {
    const namespace = "raw-doctor-bindings";
    const { seed, page, remove, range } = maintenance(namespace);
    seed([
      { key: "binding:a", value: { corrupt: true } },
      { key: "binding:b", value: { generation: 1 } },
      { key: "binding:c", value: { generation: 1 } },
      { key: "binding:d", value: { generation: 1 }, createdAt: -1 },
    ]);
    const database = openOpenClawStateDatabase().db;
    const replaceJson = database.prepare(
      "UPDATE plugin_state_entries SET value_json = ? WHERE plugin_id = ? AND namespace = ? AND entry_key = ?",
    );
    replaceJson.run("{malformed", "codex", namespace, "binding:a");
    replaceJson.run('{ "generation" : 1 }', "codex", namespace, "binding:b");
    replaceJson.run('{ "generation" : 1 }', "codex", namespace, "binding:c");

    const first = page(1);
    expect(first).toEqual([
      expect.objectContaining({ key: "binding:a", valueJson: "{malformed", expiresAt: null }),
    ]);
    expect(first[0]).not.toHaveProperty("value");
    await expect(range()).rejects.toThrow(/corrupt JSON/);

    const siblings = page(2, first[0]!.key);
    expect(siblings).toEqual(
      ["binding:b", "binding:c"].map((key) =>
        expect.objectContaining({
          key,
          value: { generation: 1 },
          valueJson: '{ "generation" : 1 }',
        }),
      ),
    );
    replaceJson.run('{"generation":1}', "codex", namespace, "binding:c");

    expect(() =>
      remove(siblings, () => {
        throw new Error("maintenance ownership expired");
      }),
    ).toThrow(/maintenance ownership expired/);
    expect(remove(siblings)).toEqual({ deleted: 1, changed: 1 });
    const preserved = page(4);
    expect(preserved.map((entry) => entry.key)).toEqual(["binding:a", "binding:c", "binding:d"]);
    expect(preserved[2]).not.toHaveProperty("value");
  });

  it.each([
    ["accessor", "({ get value() { onAccess(); return 1; } })"],
    ["symbol key", "({ [Symbol('hidden')]: 1 })"],
  ])(
    "rejects VM realm %s without replacing state or invoking getters",
    async (_shape, expression) => {
      const store = openAsyncStore({ namespace: "realm", maxEntries: 1 });
      await store.register("retained", "original");
      const onAccess = vi.fn();
      const value: unknown = runInNewContext(`({ nested: [${expression}] })`, { onAccess });
      await expect(store.register("retained", value)).rejects.toMatchObject({
        code: "PLUGIN_STATE_INVALID_INPUT",
        operation: "register",
      });
      expect(onAccess).not.toHaveBeenCalled();
      await expect(store.lookup("retained")).resolves.toBe("original");
    },
  );
});

describe("plugin-state-store.errors", () => {
  const testState = useState("plugin-state-errors", false, true);

  async function rejects(read: () => unknown, expected: object) {
    await expect(async () => read()).rejects.toMatchObject(expected);
  }

  it("preserves each caller's operation when a shared cold namespace load fails", async () => {
    await withOpenClawTestState({ label: "plugin-state-load-failure" }, async () => {
      const { db, path } = openOpenClawStateDatabase();
      db.exec("DROP TABLE plugin_state_entries");
      const store = openAsyncStore({ namespace: "load-failure" });
      const results = await Promise.allSettled([
        store.lookup("key"),
        store.count(),
        store.entries(),
      ]);
      for (const [index, operation] of ["lookup", "count", "entries"].entries()) {
        const result = results[index]!;
        expect(result.status).toBe("rejected");
        if (result.status !== "rejected") {
          throw new Error("Damaged plugin state unexpectedly read successfully");
        }
        expect(result.reason).toMatchObject({
          code: "PLUGIN_STATE_READ_FAILED",
          operation,
          path,
          cause: expect.objectContaining({ message: "no such table: plugin_state_entries" }),
        });
        expect(result.reason.owner.threadId).toBeGreaterThan(0);
      }
    });
  });

  it.each(["decode", "sqlite-step"] as const)(
    "preserves %s failures and releases the listing cursor",
    async (failure) => {
      await withOpenClawTestState({ label: "plugin-state-entry-cursor" }, async () => {
        const store = syncStore({ namespace: "cursor" });
        store.register("a", 1);
        store.register("b", 2);
        const { db, path } = openOpenClawStateDatabase();
        db.prepare("UPDATE plugin_state_entries SET value_json = ? WHERE entry_key = ?").run(
          "invalid first JSON",
          "a",
        );
        if (failure === "sqlite-step") {
          // The second native step must take precedence over the first row's decode failure.
          db.exec(`ALTER TABLE plugin_state_entries RENAME TO plugin_state_source;
          CREATE VIEW plugin_state_entries AS SELECT plugin_id, namespace, entry_key,
          CASE WHEN entry_key = 'b' THEN json_extract('invalid SQL JSON', '$') ELSE value_json END AS value_json,
          created_at, expires_at FROM plugin_state_source;`);
        }
        for (const connection of ["warm", "readonly"]) {
          if (connection === "readonly") {
            closePluginStateDatabase();
          }
          throws(() => store.entries(), {
            code: failure === "decode" ? "PLUGIN_STATE_CORRUPT" : "PLUGIN_STATE_READ_FAILED",
            operation: "entries",
            path,
            cause:
              failure === "decode"
                ? expect.any(SyntaxError)
                : expect.objectContaining({
                    code: "ERR_SQLITE_ERROR",
                    message: "malformed JSON",
                  }),
          });
          const writer = new DatabaseSync(path);
          try {
            writer.exec("PRAGMA busy_timeout = 0");
            const table = failure === "decode" ? "plugin_state_entries" : "plugin_state_source";
            writer.exec(`UPDATE ${table} SET created_at = created_at + 1`);
            expect(writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()).toEqual({
              busy: 0,
              log: 0,
              checkpointed: 0,
            });
          } finally {
            writer.close();
          }
        }
      });
    },
  );

  it("reports the explicit path for corrupt reads and rolls back decoding mutations", async () => {
    await withOpenClawTestState(
      { label: "plugin-state-corrupt-env", applyEnv: false },
      async (state) => {
        const options = { namespace: "corrupt", maxEntries: 10, env: state.env };
        const { sync, store } = stores(options);
        const database = openOpenClawStateDatabase({ env: state.env });
        expect(database.path).not.toBe(resolveOpenClawStateSqlitePath());
        // Seed corrupt storage before any keyed receipt can cache the row.
        database.db
          .prepare(
            "INSERT INTO plugin_state_entries (plugin_id, namespace, entry_key, value_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, NULL)",
          )
          .run("discord", "corrupt", "key", "invalid JSON", Date.now());
        const expected = {
          code: "PLUGIN_STATE_CORRUPT",
          path: database.path,
          message: "Plugin state entry contains corrupt JSON.",
          cause: expect.any(SyntaxError),
        };
        for (const connection of ["warm", "readonly"]) {
          if (connection === "readonly") {
            closePluginStateDatabase();
          }
          for (const current of [sync, store]) {
            await rejects(() => current.lookup("key"), expected);
            await rejects(() => current.entries(), expected);
            expect(await current.lookupMany(["key"])).toEqual([
              { ok: false, error: expect.objectContaining({ ...expected, operation: "lookup" }) },
            ]);
            expect(await current.count()).toBe(1);
          }
        }
        const update = vi.fn(() => "changed");
        const predicate = vi.fn(() => true);
        for (const current of [sync, store]) {
          for (const [operation, read] of [
            ["consume", () => current.consume("key")],
            ["lookup", () => current.update("key", update)],
            ["delete", () => current.deleteIf("key", predicate)],
          ] as const) {
            await rejects(read, { ...expected, operation });
          }
        }
        expect(update).not.toHaveBeenCalled();
        expect(predicate).not.toHaveBeenCalled();
        expect(
          openOpenClawStateDatabase({ env: state.env })
            .db.prepare("SELECT value_json FROM plugin_state_entries")
            .all(),
        ).toEqual([{ value_json: "invalid JSON" }]);
      },
    );
  });

  it("keeps warm ownership denials distinct from acquisition failures for the same path", async () => {
    openOpenClawStateDatabase();
    await withOpenClawTestState({ label: "plugin-state-ownership-errors" }, async () => {
      const { sync, store } = stores({ namespace: "ownership" });
      await store.register("k", 1);
      claimOpenClawStateOwnership("fixture-supervisor", {
        env: { ...process.env, OPENCLAW_SUPERVISOR_MODE: "external" },
      });
      for (const code of ["PLUGIN_STATE_WRITE_FAILED", "PLUGIN_STATE_OPEN_FAILED"]) {
        await rejects(() => sync.register("k", 2), { code, operation: "register" });
        await rejects(() => store.register("k", 2), { code, operation: "register" });
        await expect(store.lookup("k")).resolves.toBe(1);
        if (code === "PLUGIN_STATE_WRITE_FAILED") {
          expect(closeOpenClawStateDatabaseByPath(resolveOpenClawStateSqlitePath())).toBe(true);
        }
      }
    });
  });

  it("fails closed for process-local and persisted database quarantine", async () => {
    const store = openAsyncStore({ namespace: "quarantine" });
    await store.register("k", true);
    const path = resolveOpenClawStateSqlitePath();
    closePluginStateDatabase();
    const expected = {
      code: "PLUGIN_STATE_OPEN_FAILED",
      path,
      message: "Failed to open the plugin state database.",
    };
    recordOpenClawStateDatabaseOpenFailure(path, new Error("latched failure"));
    await rejects(() => store.lookup("k"), expected);
    await rejects(() => store.count(), { ...expected, operation: "count" });
    clearOpenClawStateDatabaseOpenFailure(path);
    seedOpenClawDatabaseQuarantine({
      env: testState().env,
      kind: "state",
      path,
      reason: "persisted failure",
    });
    const inspected = openNodeSqliteDatabase(path, { readOnly: true });
    try {
      // Acquisition can inspect a valid schema before discovering its quarantine.
      // That refused acquisition must not leave facts usable by the resident owner.
      admitStateSchemaFacts(inspected, path);
      expect(() =>
        openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(
          path,
          testState().env,
        ),
      ).toThrow(/is quarantined/);
      for (const read of [
        () => store.lookup("k"),
        () => store.lookupMany(["k"]),
        () => store.entries(),
        () => store.count(),
        () => store.register("k", true),
      ]) {
        await rejects(read, {
          ...expected,
          message: `${expected.message}\nDatabase integrity verification failed. Restore or repair the state database, then run openclaw doctor --fix.`,
        });
      }
    } finally {
      inspected.close();
      clearOpenClawStateDatabaseOpenFailure(path);
      expect(clearOpenClawDatabaseQuarantine(path, { env: testState().env })).toBe(true);
    }
  });

  it("reports the explicit readonly path when acquisition fails before the operation", async () => {
    await withOpenClawTestState({ label: "plugin-state-explicit-read-path" }, async (state) => {
      const explicitPath = join(state.stateDir, "explicit.sqlite");
      const database = new DatabaseSync(explicitPath);
      database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
      database.close();
      const read = vi.fn(() => undefined);
      expect(explicitPath).not.toBe(resolveOpenClawStateSqlitePath(state.env));
      throws(
        () =>
          withPluginStateDatabaseReadOnly("lookup", read, {
            path: relative(process.cwd(), explicitPath),
            env: state.env,
          }),
        {
          code: "PLUGIN_STATE_OPEN_FAILED",
          operation: "lookup",
          path: explicitPath,
        },
      );
      expect(read).not.toHaveBeenCalled();
    });
  });
});

describe("plugin-state-store.retention", () => {
  useState("plugin-state-retention");
  const open = (namespace: string, maxEntries: number, rejectNew = false) =>
    syncStore<number>({
      namespace,
      maxEntries,
      overflowPolicy: rejectNew ? "reject-new" : "evict-oldest",
    });
  const seed = (namespace: string, rows: Omit<SeedRow, "namespace" | "pluginId">[]) =>
    seedScope("discord", namespace, rows);

  it("shares quota and expiry facts while refreshing time and preserving sibling rows", () => {
    vi.useFakeTimers({ now: 1_000 });
    const scope = { pluginId: "discord", namespace: "operation-retention" };
    const params = { ...scope, maxEntries: 2, overflowPolicy: "reject-new" as const };
    seedPluginStateEntriesForTests([
      { ...scope, key: "stable", value: 1 },
      { ...scope, key: "expiring", value: 2, expiresAt: 2_000 },
      { ...scope, namespace: "sibling", key: "expired", value: 3, expiresAt: 800 },
    ]);
    const current = open(scope.namespace, 2, true);
    const sibling = open("sibling", 2);
    const counts = runWriteTransaction("register", (store) => {
      const retention = readPluginStateRetention(store.db, { ...scope, now: Date.now() });
      const replace = (valueJson: string) =>
        registerPluginStateEntry(store, { ...params, key: "stable", valueJson }, retention, true);
      const statements = trackSqliteStatementExecutions(
        requireNativeSqliteDatabase(store.db),
        ["expiryProbe", "delete"],
        (sql) =>
          sql.startsWith('select "expires_at" from "plugin_state_entries"')
            ? "expiryProbe"
            : sql.startsWith('delete from "plugin_state_entries"')
              ? "delete"
              : null,
      );
      try {
        replace("4");
      } finally {
        statements.restore();
      }
      vi.setSystemTime(2_000);
      replace("5");
      return statements.counts;
    });
    vi.setSystemTime(500);
    expect(current.entries()).toEqual([entryOf("stable", 5, 2_000)]);
    expect(sibling.lookup("expired")).toBe(3);

    seedPluginStateEntriesForTests([
      { ...scope, key: "backward-visible", value: 6, expiresAt: 1_500 },
    ]);
    vi.setSystemTime(2_000);
    expect(() =>
      runWriteTransaction("register", (store) => {
        const retention = readPluginStateRetention(store.db, { ...scope, now: Date.now() });
        vi.setSystemTime(1_000);
        registerPluginStateEntry(
          store,
          { ...params, key: "over-capacity", valueJson: "7" },
          retention,
          false,
        );
      }),
    ).toThrow("reached its 2-row limit");
    expect(current.lookup("over-capacity")).toBeUndefined();
    expect(counts).toEqual({ expiryProbe: 0, delete: 0 });
  });

  it("evicts oldest live entries over maxEntries with bounded database calls", () => {
    vi.useFakeTimers({ now: 1000 });
    seed(
      "evict",
      Array.from({ length: 64 }, (_, n) =>
        entryOf(`key-${String(n).padStart(2, "0")}`, n, n >= 61 ? 1000 : Math.floor(n / 2)),
      ),
    );
    const store = open("evict", 3);
    const statements = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(openOpenClawStateDatabase().db),
      ["delete"],
      (sql) => (sql.startsWith('delete from "plugin_state_entries"') ? "delete" : null),
    );
    try {
      store.register("a-protected", 64);
    } finally {
      statements.restore();
    }

    // The final victim ties the protected key; work stays bounded across all 62 victims.
    expect(statements.counts.delete).toBeGreaterThan(0);
    expect(statements.counts.delete).toBeLessThanOrEqual(2);
    expect(store.entries()).toEqual([
      entryOf("a-protected", 64, 1000),
      entryOf("key-62", 62, 1000),
      entryOf("key-63", 63, 1000),
    ]);
  });

  it.each(["native", "worker"] as const)(
    "replaces a %s expired claim beyond cleanup",
    async (mode) => {
      vi.spyOn(Date, "now").mockReturnValue(2_000);
      const namespace = "claim-expiry-batch";
      seed(namespace, [
        ...Array.from({ length: PLUGIN_STATE_EXPIRY_BATCH_ROWS + 1 }, (_, index) => ({
          key: `expired-${index}`,
          value: index,
          expiresAt: 1_000,
        })),
        { key: "target", value: -1, expiresAt: 1_500 },
      ]);
      const options = { namespace, maxEntries: 1, overflowPolicy: "reject-new" as const };
      const store = mode === "native" ? syncStore(options) : openAsyncStore(options);
      expect(await store.registerIfAbsent("target", 42)).toBe(true);
      expect(await store.entries()).toEqual([
        entryOf("target", 42, mode === "native" ? 2_000 : expect.any(Number)),
      ]);
      expect(
        openOpenClawStateDatabase()
          .db.prepare("SELECT count(*) AS count FROM plugin_state_entries WHERE expires_at <= ?")
          .get(2_000)?.count,
      ).toBe(1);
    },
  );

  it("protects a worker claim when existing rows have later timestamps", async () => {
    const store = keyedStore<number>("discord", "evict-worker-claim", { maxEntries: 1 });
    seed("evict-worker-claim", [entryOf("z", 1, Date.now() + 24 * 60 * 60 * 1000)]);
    const before = Date.now();
    expect(await store.registerIfAbsent("a", 2)).toBe(true);
    const after = Date.now();
    const entries = await store.entries();
    expect(entries).toMatchObject([{ key: "a", value: 2 }]);
    expect(entries[0]?.createdAt).toBeGreaterThanOrEqual(before);
    expect(entries[0]?.createdAt).toBeLessThanOrEqual(after);
  });

  it("sheds sequenced journal rows without evicting durable sibling state", async () => {
    const durableEntryCount = 37;
    const row = (namespace: string, key: string, value: unknown) => ({
      pluginId: "memory-core",
      namespace,
      key,
      value,
    });
    const store = (namespace: string, maxEntries: number, rejectNew = false) =>
      createPluginStateKeyedStore("memory-core", {
        namespace,
        maxEntries,
        overflowPolicy: rejectNew ? "reject-new" : "evict-oldest",
      });
    seedPluginStateEntriesForTests([
      ...Array.from({ length: durableEntryCount }, (_, entryIndex) =>
        row("durable-state", `durable-${entryIndex}`, { entryIndex }),
      ),
      row("memory-host.event-migration-checkpoints", "generation", { kind: "raw-checkpoint" }),
      row("memory-host.event-cursors", "workspace", { kind: "cursor", lastSequence: 9 }),
      row("memory-host.events", "event-0000000000000009", { sequence: 9 }),
    ]);

    expect(
      await registerPluginStateSequencedJournalEntry({
        pluginId: "memory-core",
        cursorOptions: { namespace: "memory-host.event-cursors", maxEntries: 1_000 },
        cursorKey: "workspace",
        journalOptions: { namespace: "memory-host.events", maxEntries: 1 },
        journalKeyPrefix: "event-",
        journalKeyRange: { keyStartInclusive: "event-", keyEndExclusive: "event." },
        journalValue: {},
      }),
    ).toBe(10);

    const durable = store("durable-state", durableEntryCount);
    const checkpoints = store("memory-host.event-migration-checkpoints", 10_000, true);
    const journal = store("memory-host.events", 1);
    const cursor = store("memory-host.event-cursors", 1_000);
    await expect(durable.lookup("durable-0")).resolves.toEqual({ entryIndex: 0 });
    await expect(checkpoints.lookup("generation")).resolves.toEqual({ kind: "raw-checkpoint" });
    await expect(journal.lookup("event-0000000000000009")).resolves.toBeUndefined();
    await expect(journal.lookup("event-0000000000000010")).resolves.toEqual({ sequence: 10 });
    await expect(cursor.lookup("workspace")).resolves.toEqual({
      kind: "cursor",
      lastSequence: 10,
    });
  });
});
