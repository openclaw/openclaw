import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import type {
  OpenKeyedStoreOptions,
  OpenRetainedKeyedStoreOptions,
} from "../plugin-sdk/plugin-state-runtime.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closePluginStateDatabaseAsync,
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
  resetPluginStateStoreForTests,
} from "./plugin-state-store.js";
import { seedPluginStateEntriesForTests } from "./plugin-state-store.test-helpers.js";

const pluginId = "retained-storage-test";
const retainedOptions: OpenRetainedKeyedStoreOptions = {
  namespace: "history",
  retention: "retained",
};
const key = (id: number) => String(id).padStart(10, "0");

afterEach(async () => {
  await closePluginStateDatabaseAsync();
  resetPluginStateStoreForTests();
});

describe("retained plugin state", () => {
  it("retains all rows across writes and reopening beyond bounded-store limits", async () => {
    await withOpenClawTestState({ label: "retained-storage-capacity" }, async () => {
      seedPluginStateEntriesForTests(
        Array.from({ length: 50_001 }, (_, id) => ({
          pluginId,
          namespace: "@retained.history",
          key: key(id),
          value: id,
          createdAt: id,
        })),
      );
      await closePluginStateDatabaseAsync();
      resetPluginStateStoreForTests();

      const retained = createPluginStateKeyedStore<number>(pluginId, retainedOptions);
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
      await closePluginStateDatabaseAsync();
      resetPluginStateStoreForTests();
      const reopened = createPluginStateKeyedStore<number>(pluginId, retainedOptions);
      expect(await reopened.count()).toBe(50_005);
      expect(await reopened.lookup(key(0))).toBe(0);
      expect(await reopened.lookup(key(50_004))).toBe(50_004);
    });
  });

  it("moves raw data atomically, preserves canonical targets, and pages lexical keys", async () => {
    await withOpenClawTestState({ label: "retained-storage-move" }, async () => {
      const now = Date.now();
      seedPluginStateEntriesForTests([
        { pluginId, namespace: "history", key: "9", value: { body: "legacy 9" }, createdAt: 9 },
        { pluginId, namespace: "history", key: "10", value: { body: "superseded" }, createdAt: 10 },
        {
          pluginId,
          namespace: "history",
          key: "99",
          value: { body: "expired" },
          expiresAt: now - 1,
        },
        {
          pluginId,
          namespace: "history",
          key: "100",
          value: { body: "expiring" },
          expiresAt: now + 86_400_000,
        },
        {
          pluginId,
          namespace: "@retained.history",
          key: key(10),
          value: { body: "canonical" },
          createdAt: 1,
        },
        { pluginId: "other-plugin", namespace: "history", key: "9", value: { body: "foreign" } },
      ]);
      const raw = '{ "body": "legacy 9" }';
      openOpenClawStateDatabase()
        .db.prepare(
          "UPDATE plugin_state_entries SET value_json = ? WHERE plugin_id = ? AND namespace = ? AND entry_key = ?",
        )
        .run(raw, pluginId, "history", "9");
      const source = createPluginStateKeyedStore<{ body: string }>(pluginId, {
        namespace: "history",
        maxEntries: 10,
      });
      const retained = createPluginStateKeyedStore<{ body: string }>(pluginId, retainedOptions);
      await expect(
        retained.moveEntriesFrom({
          namespace: "history",
          entries: [9, 10, 100].map((id) => ({ sourceKey: String(id), targetKey: key(id) })),
        }),
      ).rejects.toMatchObject({ code: "PLUGIN_STATE_INVALID_INPUT" });
      expect(await source.lookup("9")).toEqual({ body: "legacy 9" });
      expect(await source.lookup("10")).toEqual({ body: "superseded" });
      expect(await retained.lookup(key(9))).toBeUndefined();
      const move = {
        namespace: "history",
        entries: [9, 10, 99, 101].map((id) => ({ sourceKey: String(id), targetKey: key(id) })),
      };
      expect(await retained.moveEntriesFrom(move)).toBe(2);
      expect(await retained.moveEntriesFrom(move)).toBe(0);
      expect(await source.lookup("9")).toBeUndefined();
      expect(await source.lookup("10")).toBeUndefined();
      expect(await retained.lookup(key(99))).toBeUndefined();
      expect(await retained.entries()).toEqual([
        { key: key(10), value: { body: "canonical" }, createdAt: 1 },
        { key: key(9), value: { body: "legacy 9" }, createdAt: 9 },
      ]);
      expect(
        openOpenClawStateDatabase()
          .db.prepare(
            "SELECT value_json, created_at, expires_at FROM plugin_state_entries WHERE plugin_id = ? AND namespace = ? AND entry_key = ?",
          )
          .get(pluginId, "@retained.history", key(9)),
      ).toEqual({
        value_json: raw,
        created_at: 9,
        expires_at: null,
      });
      const foreign = createPluginStateKeyedStore<{ body: string }>("other-plugin", {
        namespace: "history",
        maxEntries: 10,
      });
      expect(await foreign.lookup("9")).toEqual({ body: "foreign" });
      await retained.register(key(99), { body: "99" });
      await retained.register(key(100), { body: "100" });
      const range = { keyStartInclusive: key(9), keyEndExclusive: key(101), limit: 2 };
      expect((await retained.entriesInKeyRange(range)).map((entry) => entry.key)).toEqual([
        key(9),
        key(10),
      ]);
      expect(
        (await retained.entriesInKeyRange({ ...range, order: "desc" })).map((entry) => entry.key),
      ).toEqual([key(100), key(99)]);
      expect(
        (await retained.entriesInKeyRange({ ...range, keyStartInclusive: key(11) })).map(
          (entry) => entry.key,
        ),
      ).toEqual([key(99), key(100)]);
    });
  });

  it("keeps historical retained.* logical namespaces bounded and separate from retained storage", async () => {
    expectTypeOf<OpenKeyedStoreOptions["maxEntries"]>().toEqualTypeOf<number>();
    await withOpenClawTestState({ label: "retained-storage-namespace-compatibility" }, async () => {
      const namespace = "retained.history";
      seedPluginStateEntriesForTests([
        { pluginId, namespace, key: "legacy", value: 1, createdAt: 1 },
      ]);
      const options = { namespace, maxEntries: 1 };
      const sync = createPluginStateSyncKeyedStore<number>(pluginId, options);
      expect(sync.lookup("legacy")).toBe(1);
      const bounded = createPluginStateKeyedStore<number>(pluginId, options);
      const retained = createPluginStateKeyedStore<number>(pluginId, {
        namespace,
        retention: "retained",
      });
      await retained.register("fresh", 3);
      await bounded.register("fresh", 2);
      expect(sync.lookup("legacy")).toBeUndefined();
      expect(sync.lookup("fresh")).toBe(2);
      expect(await retained.lookup("fresh")).toBe(3);
    });
  });

  it("preserves the full 128-byte logical namespace limit in retained mode", async () => {
    await withOpenClawTestState({ label: "retained-storage-namespace-length" }, async () => {
      const options = { namespace: "n".repeat(128), retention: "retained" as const };
      const retained = createPluginStateKeyedStore<number>(pluginId, options);
      await retained.register("last-byte", 128);
      await closePluginStateDatabaseAsync();
      resetPluginStateStoreForTests();
      const reopened = createPluginStateKeyedStore<number>(pluginId, options);
      expect(await reopened.lookup("last-byte")).toBe(128);
      expect(() =>
        createPluginStateKeyedStore(pluginId, {
          ...options,
          namespace: `${options.namespace}n`,
        }),
      ).toThrow(expect.objectContaining({ code: "PLUGIN_STATE_INVALID_INPUT" }));
    });
  });

  it("rejects retention collisions, TTLs, and invalid move batches before mutation", async () => {
    await withOpenClawTestState({ label: "retained-storage-validation" }, async () => {
      expect(() =>
        Reflect.apply(createPluginStateSyncKeyedStore, undefined, [pluginId, retainedOptions]),
      ).toThrow();
      for (const open of [createPluginStateKeyedStore, createPluginStateSyncKeyedStore]) {
        expect(() => open(pluginId, { namespace: "@retained.history", maxEntries: 10 })).toThrow();
      }
      expect(() =>
        Reflect.apply(createPluginStateKeyedStore, undefined, [
          pluginId,
          { ...retainedOptions, maxEntries: 10 },
        ]),
      ).toThrow();
      const retained = createPluginStateKeyedStore<number>(pluginId, retainedOptions);
      const bounded = createPluginStateKeyedStore<number>(pluginId, {
        namespace: "history",
        maxEntries: 10,
      });
      await bounded.register("a", 1);
      await bounded.register("b", 2);
      await expect(retained.register("ttl", 1, { ttlMs: 1_000 })).rejects.toMatchObject({
        code: "PLUGIN_STATE_INVALID_INPUT",
      });
      await expect(retained.registerIfAbsent("ttl", 1, { ttlMs: 1_000 })).rejects.toMatchObject({
        code: "PLUGIN_STATE_INVALID_INPUT",
      });
      await expect(retained.update("ttl", () => 1, { ttlMs: 1_000 })).rejects.toMatchObject({
        code: "PLUGIN_STATE_INVALID_INPUT",
      });
      const observed = await retained.observe("ttl");
      await expect(
        retained.compareAndApply("ttl", observed.comparison, {
          operation: "update",
          action: "set",
          value: 1,
          ttlMs: 1_000,
        }),
      ).rejects.toMatchObject({ code: "PLUGIN_STATE_INVALID_INPUT" });
      for (const move of [
        { namespace: "@retained.history", entries: [{ sourceKey: "a", targetKey: "a" }] },
        {
          namespace: "history",
          entries: [
            { sourceKey: "a", targetKey: "a" },
            { sourceKey: "b", targetKey: " a " },
          ],
        },
        {
          namespace: "history",
          entries: [
            { sourceKey: "a", targetKey: "a" },
            { sourceKey: "a", targetKey: "b" },
          ],
        },
        { namespace: "history", entries: [{ sourceKey: "a", targetKey: " " }] },
        {
          namespace: "history",
          entries: Array.from({ length: 10_001 }, (_, id) => ({
            sourceKey: String(id),
            targetKey: key(id),
          })),
        },
      ]) {
        await expect(retained.moveEntriesFrom(move)).rejects.toMatchObject({
          code: "PLUGIN_STATE_INVALID_INPUT",
        });
      }
      await expect(
        bounded.moveEntriesFrom({ namespace: "history", entries: [] }),
      ).rejects.toMatchObject({ code: "PLUGIN_STATE_INVALID_INPUT" });
      expect(await retained.count()).toBe(0);
      expect(await bounded.lookupMany(["a", "b"])).toEqual([
        { ok: true, value: 1 },
        { ok: true, value: 2 },
      ]);
    });
  });
});
