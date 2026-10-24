import { chmodSync, existsSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runInNewContext } from "node:vm";
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { ok } from "@openclaw/normalization-core/result";
import { beforeAll, describe, expect, it, vi } from "vitest";
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
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { keyedStore, keyedStores, useState } from "./plugin-state-fixtures.test-support.js";
import {
  runWriteTransaction,
  withPluginStateDatabaseReadOnly,
} from "./plugin-state-store.database.js";
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
const invalidWrite = { code: "PLUGIN_STATE_INVALID_INPUT", operation: "register" };
const limitExceeded = { code: "PLUGIN_STATE_LIMIT_EXCEEDED" };
const invalidLookup = { code: "PLUGIN_STATE_INVALID_INPUT", operation: "lookup" };

const defaults = { namespace: "test", maxEntries: 10 };
function syncStore<T>(options: Partial<OpenKeyedStoreOptions> = {}, pluginId = "discord") {
  return createPluginStateSyncKeyedStore<T>(pluginId, { ...defaults, ...options });
}
function openAsyncStore<T>(options: Partial<OpenKeyedStoreOptions> = {}, pluginId = "discord") {
  return createPluginStateKeyedStore<T>(pluginId, { ...defaults, ...options });
}
function stores<T>(options: Partial<OpenKeyedStoreOptions> = {}, pluginId = "discord") {
  return keyedStores<T>(pluginId, { ...defaults, ...options });
}
function throws(action: () => unknown, expected: object) {
  expect(action).toThrowError(expect.objectContaining(expected));
}
function replaceJson(pluginId: string, namespace: string, key: string, json: string) {
  openOpenClawStateDatabase()
    .db.prepare(
      "UPDATE plugin_state_entries SET value_json = ? WHERE plugin_id = ? AND namespace = ? AND entry_key = ?",
    )
    .run(json, pluginId, namespace, key);
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

  it("round-trips realm values and exact bulk keys across reopen", async () => {
    const { sync, store } = stores();
    const value = { nested: [{ count: 1, labels: ["retained", null] }] };
    const realmValue: unknown = runInNewContext(
      '({ nested: [{ count: 1, labels: ["retained", null] }] })',
    );
    await store.register("nested", realmValue);
    const keys = ["10", "2", "nul\0tail", "\\u0000", "\ud800", "__proto__"] as const;
    for (const [index, key] of keys.entries()) {
      await store.register(key, { index });
    }
    seedScope("discord", "test", [{ key: "expired", value: {}, expiresAt: Date.now() }]);
    if (process.platform !== "win32") {
      const path = resolveOpenClawStateSqlitePath();
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    closePluginStateDatabase();
    const request = [...keys.toReversed(), "missing", "expired", " 2 "];
    const expected = [
      ...keys.map((_, index) => ({ index })).toReversed(),
      undefined,
      undefined,
      { index: 1 },
    ];
    for (const current of [sync, store]) {
      expect(await current.lookup("nested")).toEqual(value);
      expect(await current.lookupMany(request)).toEqual(expected.map(ok));
      const duplicates = await current.lookupMany(["nested", "nested"]);
      expect(duplicates[0]?.ok && duplicates[0].value).not.toBe(
        duplicates[1]?.ok && duplicates[1].value,
      );
    }
    expect(sync.lookupMany([])).toEqual([]);
    throws(() => sync.lookupMany(["nested", " "]), invalidLookup);
    await expect(
      store.lookupMany(Array.from({ length: 10_001 }, () => "missing")),
    ).rejects.toMatchObject(invalidLookup);
    expect(sync.lookupMany(Array.from({ length: 10_000 }, () => "missing"))).toEqual(
      Array.from({ length: 10_000 }, () => ok(undefined)),
    );
    expect(isOpenClawStateDatabaseOpen()).toBe(false);
  });

  it("rejects new durable rows at capacity without evicting or blocking updates", async () => {
    vi.useFakeTimers();
    const store = syncStore<number>(
      { namespace: "durable-bindings", maxEntries: 2, overflowPolicy: "reject-new" },
      "codex",
    );
    vi.setSystemTime(1000);
    const update = store.update;
    expect(update("first", (current) => (current ?? 0) + 1)).toBe(true);
    expect(store.lookup("first")).toBe(1);
    vi.setSystemTime(2000);
    expect(store.registerIfAbsent("second", 2)).toBe(true);

    const limit = { ...limitExceeded, operation: "register" };
    throws(() => store.register("third", 3), limit);
    expect(store.registerIfAbsent("first", 99)).toBe(false);
    vi.setSystemTime(3000);
    expect(update("first", (current) => (current ?? 0) + 9)).toBe(true);
    expect(update("first", () => undefined)).toBe(false);
    throws(() => store.update("third", () => 3), limit);
    expect(store.entries()).toEqual([
      expect.objectContaining({ key: "second", value: 2 }),
      expect.objectContaining({ key: "first", value: 10 }),
    ]);
  });

  it("deletes an entry only when the current value matches", async () => {
    const store = openAsyncStore<number>();
    await store.register("chat", 1);
    expect(await store.deleteIf("chat", (current) => current === 2)).toBe(false);
    expect(await store.lookup("chat")).toBe(1);
    expect(await store.deleteIf("chat", (current) => current === 1)).toBe(true);
    expect(await store.lookup("chat")).toBeUndefined();
  });

  it("rejects plugin state ttl when expiry cannot fit in a Date timestamp", async () => {
    const store = openAsyncStore();

    await expect(store.register("huge", true, { ttlMs: Number.MAX_VALUE })).rejects.toMatchObject(
      invalidWrite,
    );
    vi.spyOn(Date, "now").mockReturnValue(MAX_DATE_TIMESTAMP_MS);
    throws(() => syncStore().register("overflow", true, { ttlMs: 60_000 }), invalidWrite);
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
    for (const value of [undefined, Infinity, circular, sparse, new Date(), nonEnumerable]) {
      await expect(store.register("invalid", value)).rejects.toThrow(PluginStateStoreError);
    }
    for (const key of [" ", "k".repeat(513)]) {
      await expect(store.register(key, true)).rejects.toThrow(PluginStateStoreError);
    }

    let deep: unknown = { leaf: true };
    for (let i = 0; i < 65; i += 1) {
      deep = { nested: deep };
    }
    await expect(store.register("deep", deep)).rejects.toMatchObject(limitExceeded);
    await expect(store.lookup(" ")).rejects.toMatchObject(invalidLookup);
    await expect(store.delete(" ")).rejects.toMatchObject({
      ...invalidLookup,
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
      await expect(write()).rejects.toMatchObject(limitExceeded);
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
    const store = createCorePluginStateSyncKeyedStore<boolean>(options);
    const asyncStore = createCorePluginStateKeyedStore<boolean>(options);
    const workerStore = createCorePluginStateKeyedStoreV2<boolean>(options, {
      assertCurrent: () => {},
    });
    expect(store.update(key, () => true)).toBe(true);
    closePluginStateDatabase();
    expect(await asyncStore.lookup(key)).toBe(true);
    const observation = await workerStore.observe(key);
    store.register(key, false);
    await expect(
      workerStore.compareAndApply(key, observation.comparison, {
        operation: "delete",
        action: "delete",
      }),
    ).resolves.toMatchObject({ status: "conflict" });
    expect(await workerStore.lookup(key)).toBe(false);
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

  it("pages corrupt rows and bulk-deletes only unchanged scoped bytes", async () => {
    const namespace = "bindings";
    const { seed, page, remove, range } = maintenance(namespace);
    const key = (index: number) => `binding:${String(index).padStart(4, "0")}`;
    seed([
      ...Array.from({ length: MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES }, (_, index) => ({
        key: key(index),
        value: 1,
        createdAt: index === 3 ? -1 : 0,
      })),
      { namespace: "other", key: key(0), value: true },
      { pluginId: "other", namespace, key: key(0), value: true },
    ]);
    replaceJson("codex", namespace, key(0), "{malformed");
    for (const index of [1, 2]) {
      replaceJson("codex", namespace, key(index), " 1 ");
    }
    const first = page(1);
    expect(first).toEqual([
      expect.objectContaining({ key: key(0), valueJson: "{malformed", expiresAt: null }),
    ]);
    expect(first[0]).not.toHaveProperty("value");
    await expect(range()).rejects.toThrow(/corrupt JSON/);
    expect(page(2, key(0))).toEqual(
      [1, 2].map((index) =>
        expect.objectContaining({ key: key(index), value: 1, valueJson: " 1 " }),
      ),
    );
    const observed = page(MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES);
    expect(observed[3]).not.toHaveProperty("value");
    replaceJson("codex", namespace, key(2), "1");
    const store = syncStore<number>(
      { namespace, maxEntries: MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES },
      "codex",
    );
    store.register(key(4), 2);
    expect(() =>
      remove(observed, () => {
        throw new Error("maintenance ownership expired");
      }),
    ).toThrow(/maintenance ownership expired/);
    const transactions: boolean[] = [];
    expect(
      remove(observed, (database) => {
        transactions.push(database.isTransaction);
      }),
    ).toEqual({
      deleted: MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES - 2,
      changed: 2,
    });
    expect(transactions).toEqual([true]);
    expect(page(4).map((entry) => entry.key)).toEqual([key(2), key(4)]);
    expect(store.lookup(key(4))).toBe(2);
    for (const [pluginId, retainedNamespace] of [
      ["codex", "other"],
      ["other", namespace],
    ]) {
      expect(
        syncStore({ namespace: retainedNamespace, maxEntries: 1 }, pluginId).lookup(key(0)),
      ).toBe(true);
    }
    expect(() => remove([...observed, observed[0]!])).toThrow(/cannot exceed 512 entries/);
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
      await expect(store.register("retained", value)).rejects.toMatchObject(invalidWrite);
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
        replaceJson("discord", "cursor", "a", "invalid first JSON");
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
          const code = failure === "decode" ? "PLUGIN_STATE_CORRUPT" : "PLUGIN_STATE_READ_FAILED";
          const cause =
            failure === "decode"
              ? expect.any(SyntaxError)
              : expect.objectContaining({ code: "ERR_SQLITE_ERROR", message: "malformed JSON" });
          throws(() => store.entries(), { code, operation: "entries", path, cause });
          using writer = new DatabaseSync(path);
          writer.exec("PRAGMA busy_timeout = 0");
          const table = failure === "decode" ? "plugin_state_entries" : "plugin_state_source";
          writer.exec(`UPDATE ${table} SET created_at = created_at + 1`);
          expect(writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()).toEqual({
            busy: 0,
            log: 0,
            checkpointed: 0,
          });
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
            expect(await current.lookupMany(["key"])).toEqual([
              { ok: false, error: expect.objectContaining({ ...expected, operation: "lookup" }) },
            ]);
          }
        }
        expect(await store.count()).toBe(1);
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

  it("rechecks quota when the clock moves backward", () => {
    vi.useFakeTimers({ now: 2_000 });
    const scope = { pluginId: "discord", namespace: "operation-retention" };
    const params = { ...scope, maxEntries: 2, overflowPolicy: "reject-new" as const };
    seedPluginStateEntriesForTests([
      { ...scope, key: "stable", value: 1 },
      { ...scope, key: "backward-visible", value: 2, expiresAt: 1_500 },
    ]);
    const current = open(scope.namespace, 2, true);
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

  it("protects a worker claim and breaks eviction ties by key", async () => {
    const store = keyedStore<number>("discord", "evict-worker-claim", { maxEntries: 2 });
    const future = Date.now() + 24 * 60 * 60 * 1000;
    seed("evict-worker-claim", [entryOf("y", 1, future), entryOf("z", 3, future)]);
    const before = Date.now();
    expect(await store.registerIfAbsent("a", 2)).toBe(true);
    const after = Date.now();
    const entries = await store.entries();
    expect(entries).toMatchObject([
      { key: "a", value: 2 },
      { key: "z", value: 3 },
    ]);
    expect(entries[0]?.createdAt).toBeGreaterThanOrEqual(before);
    expect(entries[0]?.createdAt).toBeLessThanOrEqual(after);
  });
});
