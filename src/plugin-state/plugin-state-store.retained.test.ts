import { afterEach, describe, expect, vi } from "vitest";
import { useSqliteWorkerFault } from "../../test/helpers/sqlite-worker-fault.js";
import type {
  OpenKeyedStoreOptions,
  OpenRetainedKeyedStoreOptions,
} from "../plugin-sdk/plugin-state-runtime.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  keyedStore,
  observePluginStateReads,
  stateTest,
  useState,
} from "./plugin-state-fixtures.test-support.js";
import { pluginStatePublication } from "./plugin-state-publication.js";
import {
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
  resetPluginStateStoreForTests,
  getPluginStateCapacity,
} from "./plugin-state-store.js";
import { seedPluginStateEntriesForTests } from "./plugin-state-store.test-helpers.js";

type SeedRow = Parameters<typeof seedPluginStateEntriesForTests>[0][number];
type ScopedSeedRow = Pick<SeedRow, "key" | "value"> & Partial<SeedRow>;
const seedScope = (pluginId: string, namespace: string, rows: ScopedSeedRow[]) =>
  seedPluginStateEntriesForTests(rows.map((row) => ({ pluginId, namespace, ...row })));
const syncStore = <T>(options: Partial<OpenKeyedStoreOptions>) =>
  createPluginStateSyncKeyedStore<T>("discord", { maxEntries: 10, namespace: "test", ...options });
const invalid = (promise: Promise<unknown>) =>
  expect(promise).rejects.toMatchObject({ code: "PLUGIN_STATE_INVALID_INPUT" });
const reopen = async () => {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
};

const moveFault = useSqliteWorkerFault([
  {
    name: "fail_last_retained_move",
    match: /^delete from plugin_state_entries\b/u,
    sql: `CREATE TEMP TRIGGER fail_last_retained_move BEFORE DELETE ON main.plugin_state_entries
      WHEN OLD.plugin_id = 'retained-storage-test' AND OLD.namespace = 'history' AND OLD.entry_key = '64'
      BEGIN SELECT RAISE(ABORT, 'synthetic retained move failure'); END;`,
  },
]);

const it = stateTest("plugin-state-store.retained");

describe("plugin-state-store.retained", () => {
  const pluginId = "retained-storage-test";
  const retainedOptions: OpenRetainedKeyedStoreOptions = {
    namespace: "history",
    retention: "retained",
  };
  const key = (id: number) => String(id).padStart(10, "0");
  const batch = (pairs: Array<[string, string]>, namespace = "history") => ({
    namespace,
    entries: pairs.map(([sourceKey, targetKey]) => ({ sourceKey, targetKey })),
  });
  const open = <T>(
    options: OpenKeyedStoreOptions | OpenRetainedKeyedStoreOptions = retainedOptions,
  ) => createPluginStateKeyedStore<T>(pluginId, options);
  const seed = (rows: ScopedSeedRow[]) => seedScope(pluginId, "history", rows);
  const row = (entryKey: string, value: unknown, createdAt = 0, expiresAt?: number) => ({
    key: entryKey,
    value,
    createdAt,
    expiresAt,
  });
  const canonical = (...args: Parameters<typeof row>) => ({
    ...row(...args),
    namespace: "@retained.history",
  });
  const movedEntry = (id: number, value: unknown, createdAt: number) => ({
    key: key(id),
    value,
    createdAt,
  });
  const pairs = (ids: number[]) => ids.map((id) => ({ sourceKey: String(id), targetKey: key(id) }));
  const query = (sql: string) => openOpenClawStateDatabase().db.prepare(sql);
  const snapshot = () =>
    query(
      "SELECT * FROM plugin_state_entries WHERE plugin_id = ? ORDER BY namespace, entry_key",
    ).all(pluginId);

  afterEach(async () => {
    vi.restoreAllMocks();
    await reopen();
  });

  it("persists over 50k retained rows without capping sibling namespaces", async ({
    state: _state,
  }) => {
    seed(Array.from({ length: 50_001 }, (_, id) => canonical(key(id), id, id)));
    await reopen();

    const retained = open<number>();
    await retained.register(key(50_001), 50_001);
    expect(await retained.registerIfAbsent(key(50_002), 50_002)).toBe(true);
    const absent = await retained.observe(key(50_003));
    expect(
      await retained.compareAndApply(key(50_003), absent.comparison, {
        operation: "update",
        action: "set",
        value: 50_003,
      }),
    ).toEqual({ status: "applied" });
    expect(await retained.update(key(50_004), () => 50_004)).toBe(true);
    await reopen();
    const reopened = open<number>();
    expect([
      await reopened.count(),
      await reopened.lookup(key(0)),
      await reopened.lookup(key(50_004)),
    ]).toEqual([50_005, 0, 50_004]);
    const options = { namespace: "sibling", maxEntries: 2, overflowPolicy: "reject-new" as const };
    const sync = createPluginStateSyncKeyedStore<number>(pluginId, options);
    const worker = open<number>(options);
    sync.register("native", 1);
    await worker.register("worker", 2);
    expect(await worker.lookupMany(["native", "worker"])).toEqual([
      { ok: true, value: 1 },
      { ok: true, value: 2 },
    ]);
    expect(getPluginStateCapacity(pluginId).liveEntries).toBe(50_007);
    expect(await reopened.count()).toBe(50_005);
  });

  it("moves raw rows atomically and pages lexical keys", async ({ state: _state }) => {
    const now = Date.now();
    seed([
      row("9", { body: "legacy 9" }, 9),
      row("10", { body: "superseded" }, 10),
      row("99", { body: "expired" }, 0, now - 1),
      row("100", { body: "expiring" }, 0, now + 86_400_000),
      canonical(key(10), { body: "canonical" }, 1),
      { pluginId: "other-plugin", namespace: "history", key: "9", value: { body: "foreign" } },
    ]);
    const raw = '{ "body": "legacy 9" }';
    query(
      "UPDATE plugin_state_entries SET value_json = ? WHERE plugin_id = ? AND namespace = ? AND entry_key = ?",
    ).run(raw, pluginId, "history", "9");
    const source = open<{ body: string }>({ namespace: "history", maxEntries: 10 });
    const retained = open<{ body: string }>();
    await invalid(retained.moveEntriesFrom({ namespace: "history", entries: pairs([9, 10, 100]) }));
    expect(await source.lookupMany(["9", "10"])).toEqual([
      { ok: true, value: { body: "legacy 9" } },
      { ok: true, value: { body: "superseded" } },
    ]);
    expect(await retained.lookup(key(9))).toBeUndefined();
    const reads = observePluginStateReads();
    const move = { namespace: "history", entries: pairs([9, 10, 99, 101]) };
    expect(await retained.moveEntriesFrom(move)).toBe(2);
    expect(await retained.moveEntriesFrom(move)).toBe(0);
    expect(await source.lookup("9")).toBeUndefined();
    expect(await source.lookup("10")).toBeUndefined();
    expect(await retained.lookup(key(99))).toBeUndefined();
    expect(await retained.entries()).toEqual([
      movedEntry(10, { body: "canonical" }, 1),
      movedEntry(9, { body: "legacy 9" }, 9),
    ]);
    expect(reads).not.toHaveBeenCalled();
    expect(
      query(
        "SELECT value_json, created_at, expires_at FROM plugin_state_entries WHERE plugin_id = ? AND namespace = ? AND entry_key = ?",
      ).get(pluginId, "@retained.history", key(9)),
    ).toEqual({ value_json: raw, created_at: 9, expires_at: null });
    const foreign = keyedStore<{ body: string }>("other-plugin", "history");
    expect(await foreign.lookup("9")).toEqual({ body: "foreign" });
    await retained.register(key(99), { body: "99" });
    await retained.register(key(100), { body: "100" });
    const range = { keyStartInclusive: key(9), keyEndExclusive: key(101), limit: 2 };
    const page = async (
      overrides: Partial<Parameters<typeof retained.entriesInKeyRange>[0]> = {},
    ) => (await retained.entriesInKeyRange({ ...range, ...overrides })).map((entry) => entry.key);
    expect(await page()).toEqual([key(9), key(10)]);
    expect(await page({ order: "desc" })).toEqual([key(100), key(99)]);
    expect(await page({ keyStartInclusive: key(11) })).toEqual([key(99), key(100)]);
  });

  it("rolls back late moves and publishes full retries", async ({ state: _state }) => {
    const entries = pairs(Array.from({ length: 65 }, (_, id) => id));
    seed([
      ...entries.map((entry, id) => row(entry.sourceKey, { id }, id + 100)),
      canonical(key(0), { id: -1 }, 1),
      canonical(key(64), { id: -2 }, 2, Date.now() - 1_000),
    ]);
    const before = snapshot();
    await closeOpenClawStateDatabaseAsync();
    const source = open<{ id: number }>({ namespace: "history", maxEntries: 100 });
    const retained = open<{ id: number }>();
    expect(await retained.moveEntriesFrom({ namespace: "history", entries: [] })).toBe(0);
    let commits = 0;
    const stop = pluginStatePublication.subscribeFacts((change) => {
      if (change.kind === "committed") {
        commits += 1;
      }
    });
    try {
      const move = { namespace: "history", entries };
      moveFault.enable();
      await expect(retained.moveEntriesFrom(move)).rejects.toMatchObject({
        code: "PLUGIN_STATE_WRITE_FAILED",
        cause: { message: "synthetic retained move failure" },
      });
      moveFault.disable();
      expect(commits).toBe(0);
      await closeOpenClawStateDatabaseAsync();
      expect(snapshot()).toEqual(before);
      await closeOpenClawStateDatabaseAsync();

      expect(await source.lookup("0")).toEqual({ id: 0 });
      expect(await retained.lookup(key(1))).toBeUndefined();
      expect(await retained.moveEntriesFrom(move)).toBe(65);
      expect(commits).toBe(1);
      expect(await source.entries()).toEqual([]);
      expect(await retained.entries()).toEqual([
        movedEntry(0, { id: -1 }, 1),
        ...entries
          .slice(1)
          .map((_, index) => movedEntry(index + 1, { id: index + 1 }, index + 101)),
      ]);
    } finally {
      moveFault.disable();
      stop();
    }
  });

  it("isolates bounded retained.* from retained storage", async ({ state: _state }) => {
    const namespace = "retained.history";
    seed([{ pluginId, namespace, key: "legacy", value: 1, createdAt: 1 }]);
    const options = { namespace, maxEntries: 1 };
    const sync = createPluginStateSyncKeyedStore<number>(pluginId, options);
    expect(sync.lookup("legacy")).toBe(1);
    const bounded = open<number>(options);
    const retained = open<number>({ namespace, retention: "retained" });
    await retained.register("fresh", 3);
    await bounded.register("fresh", 2);
    expect(sync.lookup("legacy")).toBeUndefined();
    expect(sync.lookup("fresh")).toBe(2);
    expect(await retained.lookup("fresh")).toBe(3);
  });

  it("accepts 128-byte namespaces, not 129-byte", async ({ state: _state }) => {
    const options = { namespace: "n".repeat(128), retention: "retained" as const };
    const retained = open<number>(options);
    await retained.register("last-byte", 128);
    await reopen();
    const reopened = open<number>(options);
    expect(await reopened.lookup("last-byte")).toBe(128);
    expect(() =>
      createPluginStateKeyedStore(pluginId, {
        ...options,
        namespace: `${options.namespace}n`,
      }),
    ).toThrow(expect.objectContaining({ code: "PLUGIN_STATE_INVALID_INPUT" }));
  });

  it("rejects invalid retained writes before mutation", async ({ state: _state }) => {
    const reserved = { namespace: "@retained.history", maxEntries: 10 };
    for (const [factory, options] of [
      [createPluginStateSyncKeyedStore, retainedOptions],
      [createPluginStateKeyedStore, { ...retainedOptions, maxEntries: 10 }],
      [createPluginStateKeyedStore, reserved],
      [createPluginStateSyncKeyedStore, reserved],
    ] as const) {
      expect(() => Reflect.apply(factory, undefined, [pluginId, options])).toThrow();
    }
    const retained = open<number>();
    const bounded = open<number>({ namespace: "history", maxEntries: 10 });
    await bounded.register("a", 1);
    await bounded.register("b", 2);
    await invalid(retained.register("ttl", 1, { ttlMs: 1_000 }));
    await invalid(retained.registerIfAbsent("ttl", 1, { ttlMs: 1_000 }));
    await invalid(retained.update("ttl", () => 1, { ttlMs: 1_000 }));
    const observed = await retained.observe("ttl");
    await invalid(
      retained.compareAndApply("ttl", observed.comparison, {
        operation: "update",
        action: "set",
        value: 1,
        ttlMs: 1_000,
      }),
    );
    for (const move of [
      batch([["a", "a"]], "@retained.history"),
      batch([
        ["a", "a"],
        ["b", " a "],
      ]),
      batch([
        ["a", "a"],
        ["a", "b"],
      ]),
      batch([["a", " "]]),
      {
        namespace: "history",
        entries: Array.from({ length: 10_001 }, (_, id) => ({
          sourceKey: String(id),
          targetKey: key(id),
        })),
      },
    ]) {
      await invalid(retained.moveEntriesFrom(move));
    }
    await invalid(bounded.moveEntriesFrom({ namespace: "history", entries: [] }));
    expect(await retained.count()).toBe(0);
    expect(await bounded.lookupMany(["a", "b"])).toEqual([
      { ok: true, value: 1 },
      { ok: true, value: 2 },
    ]);
  });
});

describe("plugin-state-store.expiry", () => {
  useState("plugin-state-expiry");

  function expiredRow(namespace: string, key: string, value: unknown, createdAt = 0) {
    return { pluginId: "discord", namespace, key, value, createdAt, expiresAt: Date.now() - 100 };
  }
  function expiredRows(namespace: string, count: number) {
    return Array.from({ length: count }, (_, index) =>
      expiredRow(namespace, `expired-${String(index).padStart(4, "0")}`, { index }, index),
    );
  }

  function expiredCount() {
    return openOpenClawStateDatabase()
      .db.prepare("SELECT count(*) AS count FROM plugin_state_entries WHERE expires_at <= ?")
      .get(Date.now())?.count;
  }

  it("bounds expired namespace cleanup during update without touching sibling rows", async () => {
    const namespace = "namespace-batched-expiry";
    seedPluginStateEntriesForTests([
      ...expiredRows(namespace, 1_031),
      { pluginId: "discord", namespace, key: "permanent", value: { durable: true } },
      expiredRow("sibling-namespace", "expired", { sibling: true }),
      Object.assign(expiredRow(namespace, "expired", { sibling: true }), {
        pluginId: "sibling-plugin",
      }),
    ]);
    const store = syncStore<{ durable?: boolean; fresh?: boolean }>({ namespace });
    expect(store.update("fresh", () => ({ fresh: true }))).toBe(true);
    expect(store.lookup("fresh")).toEqual({ fresh: true });
    expect(store.lookup("permanent")).toEqual({ durable: true });
    expect(expiredCount()).toBe(9);
  });

  it("rechecks expiry time and newly written rows after an empty namespace cleanup", () => {
    vi.useFakeTimers({ now: 1_000 });
    const scope = { pluginId: "discord", namespace: "fresh-expiry" };
    const store = syncStore({ namespace: scope.namespace });
    seedPluginStateEntriesForTests([{ ...scope, key: "future", value: 1, expiresAt: 1_200 }]);
    store.register("permanent", 2);
    expect(expiredCount()).toBe(0);

    vi.setSystemTime(1_200);
    store.register("permanent", 3);
    expect(expiredCount()).toBe(0);
    expect(store.lookup("future")).toBeUndefined();

    seedPluginStateEntriesForTests([
      { ...scope, key: "new-expired", value: 4, expiresAt: 1_100 },
      { ...scope, namespace: "sibling", key: "expired", value: 5, expiresAt: 1_100 },
    ]);
    store.register("permanent", 6);
    expect(expiredCount()).toBe(1);
    expect(store.entries()).toEqual([{ key: "permanent", value: 6, createdAt: 1_200 }]);
  });
});
