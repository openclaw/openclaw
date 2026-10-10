import { chmodSync, existsSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runInNewContext } from "node:vm";
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { ok } from "@openclaw/normalization-core/result";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  clearOpenClawDatabaseQuarantine,
  recordOpenClawDatabaseQuarantine,
} from "../state/openclaw-quarantine-store.js";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  isOpenClawStateDatabaseOpen,
  openOpenClawStateDatabase,
  clearOpenClawStateDatabaseOpenFailure,
  recordOpenClawStateDatabaseOpenFailure,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { claimOpenClawStateOwnership } from "../state/openclaw-state-ownership-operations.js";
import {
  createOpenClawTestState,
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { withPluginStateDatabaseReadOnly } from "./plugin-state-store.database.js";
import {
  getPluginStateCapacity,
  createCorePluginStateKeyedStore,
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
import {
  clearPluginStateStoreForTests,
  seedPluginStateEntriesForTests,
} from "./plugin-state-store.test-helpers.js";
import { PluginStateStoreError } from "./plugin-state-store.types.js";

describe("plugin-state-store", () => {
  let testState: OpenClawTestState | undefined;

  beforeAll(async () => {
    testState = await createOpenClawTestState({ label: "plugin-state-store" });
    rmSync(dirname(resolveOpenClawStateSqlitePath()), { recursive: true, force: true });
  });

  beforeEach(() => {
    testState?.applyEnv();
    clearPluginStateStoreForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetPluginStateStoreForTests({ closeDatabase: false });
  });

  afterAll(async () => {
    resetPluginStateStoreForTests();
    await testState?.cleanup();
  });

  const defaults = { namespace: "test", maxEntries: 10 };
  function syncStore<T>(options: Partial<OpenKeyedStoreOptions> = {}) {
    return createPluginStateSyncKeyedStore<T>("discord", { ...defaults, ...options });
  }
  function openAsyncStore<T>(options: Partial<OpenKeyedStoreOptions> = {}) {
    return createPluginStateKeyedStore<T>("discord", { ...defaults, ...options });
  }
  async function expectPluginStateStoreError(
    promise: Promise<unknown>,
    expected: { code: string; operation?: string },
  ) {
    await expect(promise).rejects.toBeInstanceOf(PluginStateStoreError);
    await expect(promise).rejects.toMatchObject(expected);
  }

  describe("plugin state keyed store", () => {
    it("round-trips nested VM realm values across store instances", async () => {
      const options = { namespace: "components", maxEntries: 10 };
      const store = createPluginStateKeyedStore("discord", options);
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

      const reopened = createPluginStateSyncKeyedStore("discord", options);
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
      const store = createPluginStateSyncKeyedStore<number>("codex", {
        namespace: "durable-bindings",
        maxEntries: 2,
        overflowPolicy: "reject-new",
      });
      vi.setSystemTime(1000);
      expect(store.registerIfAbsent("first", 1)).toBe(true);
      vi.setSystemTime(2000);
      expect(store.registerIfAbsent("second", 2)).toBe(true);

      expect(() => store.register("third", 3)).toThrowError(
        expect.objectContaining({
          code: "PLUGIN_STATE_LIMIT_EXCEEDED",
          operation: "register",
        }),
      );
      expect(store.registerIfAbsent("first", 99)).toBe(false);
      vi.setSystemTime(3000);
      expect(store.update("first", () => 10)).toBe(true);
      expect(() => store.update("third", () => 3)).toThrowError(
        expect.objectContaining({
          code: "PLUGIN_STATE_LIMIT_EXCEEDED",
          operation: "register",
        }),
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

      const nowSpy = vi.spyOn(Date, "now");
      try {
        nowSpy.mockReturnValue(MAX_DATE_TIMESTAMP_MS);
        const sync = syncStore();
        expect(() => sync.register("overflow", true, { ttlMs: 60_000 })).toThrowError(
          expect.objectContaining({ code: "PLUGIN_STATE_INVALID_INPUT", operation: "register" }),
        );
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("validates namespaces, keys, options, and JSON values before writes", async () => {
      expect(() =>
        createPluginStateKeyedStore("discord", { namespace: "../bad", maxEntries: 10 }),
      ).toThrow(PluginStateStoreError);
      expect(() =>
        createPluginStateKeyedStore("discord", { namespace: "bad-max", maxEntries: 0 }),
      ).toThrow(PluginStateStoreError);

      const store = createPluginStateKeyedStore("discord", { namespace: "valid", maxEntries: 10 });
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

      expect(() =>
        createPluginStateKeyedStore("discord", { namespace: "a".repeat(129), maxEntries: 10 }),
      ).toThrow(PluginStateStoreError);

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
      const options = {
        ownerId: "core:channel-intent" as const,
        namespace: "stopped",
        maxEntries: 10,
      };
      const store = createCorePluginStateSyncKeyedStore<{ stopped: boolean }>(options);
      const asyncStore = createCorePluginStateKeyedStore<{ stopped: boolean }>(options);
      expect(store.update("telegram:personal", () => ({ stopped: true }))).toBe(true);
      closePluginStateDatabase();
      await expect(asyncStore.lookup("telegram:personal")).resolves.toEqual({ stopped: true });
      await expect(
        asyncStore.update("telegram:personal", () => ({ stopped: false })),
      ).resolves.toBe(true);
      expect(store.lookup("telegram:personal")).toEqual({ stopped: false });
      await expect(
        asyncStore.deleteIf("telegram:personal", (current) => !current.stopped),
      ).resolves.toBe(true);
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

    it.runIf(process.platform !== "win32")(
      "reuses a process-held state database when its directory becomes inaccessible",
      async () => {
        const store = openAsyncStore();
        await store.register("k", { ok: true });
        const database = openOpenClawStateDatabase();
        const databaseDir = dirname(database.path);
        // Keep maintenance ownership observable while testing retained database access.
        chmodSync(databaseDir, 0o000);
        try {
          await expect(store.lookup("k")).resolves.toEqual({ ok: true });
          expect(database.db.isOpen).toBe(true);
        } finally {
          chmodSync(databaseDir, 0o700);
        }
      },
    );

    it.runIf(process.platform !== "win32")(
      "refuses process-held state reads when maintenance ownership becomes inaccessible",
      async () => {
        const store = openAsyncStore();
        await store.register("k", { ok: true });
        const database = openOpenClawStateDatabase();
        chmodSync(testState?.stateDir ?? "", 0o000);
        try {
          await expect(store.lookup("k")).rejects.toMatchObject({
            code: "PLUGIN_STATE_READ_FAILED",
            cause: expect.objectContaining({ message: expect.stringContaining("ownership") }),
          });
          expect(database.db.isOpen).toBe(true);
        } finally {
          chmodSync(testState?.stateDir ?? "", 0o700);
        }
      },
    );

    it("bulk reads exact keys positionally with sync/async parity across reopen", async () => {
      const options = { namespace: "bulk", maxEntries: 20 };
      const sync = createPluginStateSyncKeyedStore<{ index: number }>("discord", options);
      const asyncStore = createPluginStateKeyedStore<{ index: number }>("discord", options);
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
      createPluginStateSyncKeyedStore("discord", { ...options, namespace: "other" }).register(
        keys[0],
        { index: 98 },
      );
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
        await expect(asyncStore.lookupMany(request)).resolves.toEqual(expected.map(ok));
        for (const duplicates of [
          sync.lookupMany([keys[0], keys[0]]),
          await asyncStore.lookupMany([keys[0], keys[0]]),
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
      const store = createPluginStateSyncKeyedStore<number>("discord", {
        namespace: "bulk-bounds",
        maxEntries: 10,
      });
      const asyncStore = createPluginStateKeyedStore<number>("discord", {
        namespace: "bulk-bounds",
        maxEntries: 10,
      });
      store.register("key", 1);
      const { db } = openOpenClawStateDatabase();
      const reads = trackSqliteStatementExecutions(db, ["reads"], (sql) =>
        sql.startsWith("select ") && sql.includes('"plugin_state_entries"') ? "reads" : null,
      );
      try {
        expect(store.lookupMany([])).toEqual([]);
        expect(() => store.lookupMany(["key", " "])).toThrowError(
          expect.objectContaining({ code: "PLUGIN_STATE_INVALID_INPUT", operation: "lookup" }),
        );
        await expect(
          asyncStore.lookupMany(Array.from({ length: 10_001 }, () => "key")),
        ).rejects.toMatchObject({ code: "PLUGIN_STATE_INVALID_INPUT", operation: "lookup" });
        expect(reads.counts.reads).toBe(0);
        expect(store.lookupMany(Array.from({ length: 10_000 }, () => "key"))).toEqual(
          Array.from({ length: 10_000 }, () => ok(1)),
        );
        expect(reads.counts.reads).toBe(1);
        expect(reads.rowCounts.reads).toBe(1);
      } finally {
        reads.restore();
      }
    });

    it("bulk-deletes only unchanged scoped rows in one bounded transaction", () => {
      const namespace = "bulk-bindings";
      const scope = { pluginId: "codex", namespace };
      seedPluginStateEntriesForTests([
        ...Array.from({ length: MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES }, (_, index) => ({
          pluginId: "codex",
          namespace,
          key: `binding:${String(index).padStart(4, "0")}`,
          value: { generation: 1 },
        })),
        { pluginId: "codex", namespace: "other", key: "binding:0000", value: { keep: true } },
        { pluginId: "other", namespace, key: "binding:0000", value: { keep: true } },
      ]);
      const observed = pluginStateDoctorEntriesInKeyRange({
        ...scope,
        prefix: "binding:",
        limit: MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES,
      });
      const store = createPluginStateSyncKeyedStore<{ generation: number }>("codex", {
        namespace,
        maxEntries: MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES,
      });
      store.register("binding:0000", { generation: 2 });
      const exec = vi.spyOn(DatabaseSync.prototype, "exec");
      const ownerAssertions: boolean[] = [];
      const assertOwnedInTransaction = (database: DatabaseSync) => {
        ownerAssertions.push(database.isTransaction);
      };
      try {
        expect(
          pluginStateDeleteEntriesIfUnchanged({
            ...scope,
            entries: observed,
            assertOwnedInTransaction,
          }),
        ).toEqual({ deleted: MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES - 1, changed: 1 });
        expect(ownerAssertions).toEqual([true]);
        expect(exec.mock.calls.filter(([sql]) => sql.trim() === "BEGIN IMMEDIATE")).toHaveLength(1);
        expect(store.lookup("binding:0000")).toEqual({ generation: 2 });
        expect(
          createPluginStateSyncKeyedStore("codex", { namespace: "other", maxEntries: 1 }).lookup(
            "binding:0000",
          ),
        ).toEqual({ keep: true });
        expect(
          createPluginStateSyncKeyedStore("other", { namespace, maxEntries: 1 }).lookup(
            "binding:0000",
          ),
        ).toEqual({ keep: true });
        expect(() =>
          pluginStateDeleteEntriesIfUnchanged({
            ...scope,
            entries: [...observed, observed[0]!],
            assertOwnedInTransaction,
          }),
        ).toThrow(/cannot exceed 512 entries/);
      } finally {
        exec.mockRestore();
      }
    });

    it("pages past malformed rows and compares siblings' original JSON bytes", async () => {
      const namespace = "raw-doctor-bindings";
      const scope = { pluginId: "codex", namespace };
      seedPluginStateEntriesForTests([
        { pluginId: "codex", namespace, key: "binding:a", value: { corrupt: true } },
        { pluginId: "codex", namespace, key: "binding:b", value: { generation: 1 } },
        { pluginId: "codex", namespace, key: "binding:c", value: { generation: 1 } },
        { pluginId: "codex", namespace, key: "binding:d", value: { generation: 1 }, createdAt: -1 },
      ]);
      const database = openOpenClawStateDatabase().db;
      const replaceJson = database.prepare(
        "UPDATE plugin_state_entries SET value_json = ? WHERE plugin_id = ? AND namespace = ? AND entry_key = ?",
      );
      replaceJson.run("{malformed", "codex", namespace, "binding:a");
      replaceJson.run('{ "generation" : 1 }', "codex", namespace, "binding:b");
      replaceJson.run('{ "generation" : 1 }', "codex", namespace, "binding:c");

      const first = pluginStateDoctorEntriesInKeyRange({
        ...scope,
        prefix: "binding:",
        limit: 1,
      });
      expect(first).toEqual([
        expect.objectContaining({ key: "binding:a", valueJson: "{malformed", expiresAt: null }),
      ]);
      expect(first[0]).not.toHaveProperty("value");
      await expect(
        pluginStateEntriesInKeyRange({
          ...scope,
          keyStartInclusive: "binding:",
          keyEndExclusive: "binding;",
          limit: 1,
        }),
      ).rejects.toThrow(/corrupt JSON/);

      const siblings = pluginStateDoctorEntriesInKeyRange({
        ...scope,
        prefix: "binding:",
        after: first[0]!.key,
        limit: 2,
      });
      expect(siblings).toEqual([
        expect.objectContaining({
          key: "binding:b",
          value: { generation: 1 },
          valueJson: '{ "generation" : 1 }',
        }),
        expect.objectContaining({
          key: "binding:c",
          value: { generation: 1 },
          valueJson: '{ "generation" : 1 }',
        }),
      ]);
      replaceJson.run('{"generation":1}', "codex", namespace, "binding:c");

      expect(() =>
        pluginStateDeleteEntriesIfUnchanged({
          ...scope,
          entries: siblings,
          assertOwnedInTransaction: () => {
            throw new Error("maintenance ownership expired");
          },
        }),
      ).toThrow(/maintenance ownership expired/);
      expect(
        pluginStateDeleteEntriesIfUnchanged({
          ...scope,
          entries: siblings,
          assertOwnedInTransaction: () => {},
        }),
      ).toEqual({ deleted: 1, changed: 1 });
      const preserved = pluginStateDoctorEntriesInKeyRange({
        ...scope,
        prefix: "binding:",
        limit: 4,
      });
      expect(preserved.map((entry) => entry.key)).toEqual(["binding:a", "binding:c", "binding:d"]);
      expect(preserved[2]).not.toHaveProperty("value");
    });

    it.each([
      ["accessor", "({ get value() { onAccess(); return 1; } })"],
      ["symbol key", "({ [Symbol('hidden')]: 1 })"],
    ])(
      "rejects VM realm %s without replacing state or invoking getters",
      async (_shape, expression) => {
        const store = createPluginStateKeyedStore("discord", { namespace: "realm", maxEntries: 1 });
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
});

describe("plugin-state-store.errors", () => {
  let testState: OpenClawTestState;
  beforeAll(async () => {
    testState = await createOpenClawTestState({ label: "plugin-state-errors" });
  });
  beforeEach(() => testState.applyEnv());
  afterEach(() => resetPluginStateStoreForTests());
  afterAll(() => testState.cleanup());

  function openStore(namespace: string) {
    return createPluginStateKeyedStore("discord", { namespace, maxEntries: 10 });
  }
  async function rejects(read: () => unknown, expected: object) {
    await expect(async () => read()).rejects.toMatchObject(expected);
  }

  describe("plugin state open errors", () => {
    it.each(["decode", "sqlite-step"] as const)(
      "preserves %s failures and releases the listing cursor",
      async (failure) => {
        await withOpenClawTestState({ label: "plugin-state-entry-cursor" }, async () => {
          const store = createPluginStateSyncKeyedStore("discord", {
            namespace: "cursor",
            maxEntries: 10,
          });
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
          const sync = createPluginStateSyncKeyedStore("discord", options);
          const store = createPluginStateKeyedStore("discord", options);
          sync.register("key", "custom");
          const database = openOpenClawStateDatabase({ env: state.env });
          expect(database.path).not.toBe(resolveOpenClawStateSqlitePath());
          database.db.prepare("UPDATE plugin_state_entries SET value_json = ?").run("invalid JSON");
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
          let callbackCalled = false;
          for (const current of [sync, store]) {
            await rejects(() => current.consume("key"), { ...expected, operation: "consume" });
            await rejects(
              () =>
                current.update("key", () => {
                  callbackCalled = true;
                  return "changed";
                }),
              { ...expected, operation: "lookup" },
            );
            await rejects(
              () =>
                current.deleteIf("key", () => {
                  callbackCalled = true;
                  return true;
                }),
              { ...expected, operation: "delete" },
            );
          }
          expect(callbackCalled).toBe(false);
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
        const store = openStore("ownership");
        const sync = createPluginStateSyncKeyedStore("discord", {
          namespace: "ownership",
          maxEntries: 10,
        });
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
      const store = openStore("quarantine");
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
      expect(
        recordOpenClawDatabaseQuarantine({
          env: testState.env,
          kind: "state",
          path,
          reason: "persisted failure",
        }),
      ).toBe(true);
      try {
        for (const read of [
          () => store.lookup("k"),
          () => store.lookupMany(["k"]),
          () => store.register("k", true),
        ]) {
          await rejects(read, {
            ...expected,
            message: `${expected.message}\nDatabase integrity verification failed. Restore or repair the state database, then run openclaw doctor --fix.`,
          });
        }
      } finally {
        clearOpenClawStateDatabaseOpenFailure(path);
        expect(clearOpenClawDatabaseQuarantine(path, { env: testState.env })).toBe(true);
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
});
