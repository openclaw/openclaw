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
import { useState } from "./plugin-state-fixtures.test-support.js";
import { withPluginStateDatabaseReadOnly } from "./plugin-state-store.database.js";
import {
  getPluginStateCapacity,
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
import { closePluginStateDatabase } from "./plugin-state-store.sqlite.js";
import { seedPluginStateEntriesForTests } from "./plugin-state-store.test-helpers.js";
import { PluginStateStoreError } from "./plugin-state-store.types.js";

const defaults = { namespace: "test", maxEntries: 10 };
function syncStore<T>(options: Partial<OpenKeyedStoreOptions> = {}, pluginId = "discord") {
  return createPluginStateSyncKeyedStore<T>(pluginId, { ...defaults, ...options });
}
function openAsyncStore<T>(options: Partial<OpenKeyedStoreOptions> = {}, pluginId = "discord") {
  return createPluginStateKeyedStore<T>(pluginId, { ...defaults, ...options });
}
function stores<T>(options: Partial<OpenKeyedStoreOptions>, pluginId = "discord") {
  return { sync: syncStore<T>(options, pluginId), store: openAsyncStore<T>(options, pluginId) };
}
function maintenance(namespace: string) {
  const scope = { pluginId: "codex", namespace };
  type Row = Parameters<typeof seedPluginStateEntriesForTests>[0][number];
  return {
    seed: (
      rows: Array<
        Omit<Row, "pluginId" | "namespace"> & Partial<Pick<Row, "pluginId" | "namespace">>
      >,
    ) => seedPluginStateEntriesForTests(rows.map((row) => ({ ...scope, ...row }))),
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

  async function expectPluginStateStoreError(
    promise: Promise<unknown>,
    expected: { code: string; operation?: string },
  ) {
    await expect(promise).rejects.toBeInstanceOf(PluginStateStoreError);
    await expect(promise).rejects.toMatchObject(expected);
  }

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

    expect(() => store.register("third", 3)).toThrowError(
      expect.objectContaining({ code: "PLUGIN_STATE_LIMIT_EXCEEDED", operation: "register" }),
    );
    expect(store.registerIfAbsent("first", 99)).toBe(false);
    vi.setSystemTime(3000);
    expect(store.update("first", () => 10)).toBe(true);
    expect(() => store.update("third", () => 3)).toThrowError(
      expect.objectContaining({ code: "PLUGIN_STATE_LIMIT_EXCEEDED", operation: "register" }),
    );
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

    await expectPluginStateStoreError(store.register("huge", true, { ttlMs: Number.MAX_VALUE }), {
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation: "register",
    });

    vi.spyOn(Date, "now").mockReturnValue(MAX_DATE_TIMESTAMP_MS);
    const sync = syncStore();
    expect(() => sync.register("overflow", true, { ttlMs: 60_000 })).toThrowError(
      expect.objectContaining({ code: "PLUGIN_STATE_INVALID_INPUT", operation: "register" }),
    );
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

    await expect(store.register("k".repeat(513), { ok: true })).rejects.toThrow(
      PluginStateStoreError,
    );

    let deep: unknown = { leaf: true };
    for (let i = 0; i < 65; i += 1) {
      deep = { nested: deep };
    }
    await expectPluginStateStoreError(store.register("deep", deep), {
      code: "PLUGIN_STATE_LIMIT_EXCEEDED",
    });

    await expectPluginStateStoreError(store.lookup(" "), {
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation: "lookup",
    });
    await expectPluginStateStoreError(store.delete(" "), {
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation: "delete",
    });
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
      await expect(async () => {
        await write();
      }).rejects.toMatchObject({ code: "PLUGIN_STATE_LIMIT_EXCEEDED" });
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
    await expect(asyncStore.update(key, () => ({ stopped: false }))).resolves.toBe(true);
    expect(store.lookup(key)).toEqual({ stopped: false });
    const observation = await workerStore.observe(key);
    store.register(key, { stopped: true });
    await expect(
      workerStore.compareAndApply(key, observation.comparison, {
        operation: "delete",
        action: "delete",
      }),
    ).resolves.toMatchObject({ status: "conflict" });
    await expect(workerStore.lookup(key)).resolves.toEqual({ stopped: true });
    store.register(key, { stopped: false });
    await expect(asyncStore.deleteIf(key, (current) => !current.stopped)).resolves.toBe(true);
    await expect(asyncStore.lookup(" ")).rejects.toThrow(PluginStateStoreError);
    expect(() => createCorePluginStateKeyedStore({ ...options, maxEntries: 11 })).toThrow(
      PluginStateStoreError,
    );
    expect(() =>
      createPluginStateKeyedStore("core:not-a-plugin", { namespace: "bad", maxEntries: 10 }),
    ).toThrow(PluginStateStoreError);
  });

  it("treats a missing plugin-state database as empty without creating it", async () => {
    await withOpenClawTestState(
      { label: "plugin-state-read-only-missing", applyEnv: false },
      async (state) => {
        const store = openAsyncStore({ env: state.env });
        const databasePath = resolveOpenClawStateSqlitePath(state.env);

        expect(existsSync(databasePath)).toBe(false);
        await expect(store.lookup("k")).resolves.toBeUndefined();
        await expect(store.lookupMany(["k", "missing"])).resolves.toEqual([
          { ok: true, value: undefined },
          { ok: true, value: undefined },
        ]);
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
      {
        namespace,
        maxEntries: MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES,
      },
      "codex",
    );
    store.register("binding:0000", { generation: 2 });
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    const ownerAssertions: boolean[] = [];
    const assertOwnedInTransaction = (database: EngineConnection) => {
      ownerAssertions.push(database.isTransaction);
    };
    try {
      expect(remove(observed, assertOwnedInTransaction)).toEqual({
        deleted: MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES - 1,
        changed: 1,
      });
      expect(ownerAssertions).toEqual([true]);
      expect(exec.mock.calls.filter(([sql]) => sql.trim() === "BEGIN IMMEDIATE")).toHaveLength(1);
      expect(store.lookup("binding:0000")).toEqual({ generation: 2 });
      for (const [pluginId, retainedNamespace] of [
        ["codex", "other"],
        ["other", namespace],
      ]) {
        expect(
          syncStore({ namespace: retainedNamespace, maxEntries: 1 }, pluginId).lookup(
            "binding:0000",
          ),
        ).toEqual({ keep: true });
      }
      expect(() => remove([...observed, observed[0]!], assertOwnedInTransaction)).toThrow(
        /cannot exceed 512 entries/,
      );
    } finally {
      exec.mockRestore();
    }
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
          expect(() => store.entries()).toThrowError(
            expect.objectContaining({
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
            }),
          );
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
          await rejects(
            () =>
              pluginStateEntriesInKeyRange({
                pluginId: "discord",
                ...options,
                keyStartInclusive: "key",
                keyEndExclusive: "kez",
                limit: 1,
              }),
            expected,
          );
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
      // That refused acquisition must not leave facts usable by the keyed-store cache.
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
      expect(() =>
        withPluginStateDatabaseReadOnly("lookup", read, {
          path: relative(process.cwd(), explicitPath),
          env: state.env,
        }),
      ).toThrow(
        expect.objectContaining({
          code: "PLUGIN_STATE_OPEN_FAILED",
          operation: "lookup",
          path: explicitPath,
        }),
      );
      expect(read).not.toHaveBeenCalled();
    });
  });
});
