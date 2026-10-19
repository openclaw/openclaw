import { describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { useState } from "./plugin-state-fixtures.test-support.js";
import { runWriteTransaction } from "./plugin-state-store.database.js";
import {
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
  registerPluginStateSequencedJournalEntry,
} from "./plugin-state-store.js";
import { PLUGIN_STATE_EXPIRY_BATCH_ROWS } from "./plugin-state-store.kernel.js";
import {
  readPluginStateRetention,
  registerPluginStateEntry,
} from "./plugin-state-store.retention.js";
import { seedPluginStateEntriesForTests } from "./plugin-state-store.test-helpers.js";

useState("plugin-state-retention");
const syncStore = (namespace: string, maxEntries: number, rejectNew = false) =>
  createPluginStateSyncKeyedStore<number>("discord", {
    namespace,
    maxEntries,
    overflowPolicy: rejectNew ? "reject-new" : "evict-oldest",
  });

describe("plugin state keyed store", () => {
  it("shares quota and expiry facts while refreshing time and preserving sibling rows", () => {
    vi.useFakeTimers({ now: 1_000 });
    const scope = { pluginId: "discord", namespace: "operation-retention" };
    const params = { ...scope, maxEntries: 2, overflowPolicy: "reject-new" as const };
    seedPluginStateEntriesForTests([
      { ...scope, key: "stable", value: 1 },
      { ...scope, key: "expiring", value: 2, expiresAt: 2_000 },
      { ...scope, namespace: "sibling", key: "expired", value: 3, expiresAt: 800 },
    ]);
    const current = syncStore(scope.namespace, 2, true);
    const sibling = syncStore("sibling", 2);
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
    expect(current.entries()).toEqual([{ key: "stable", value: 5, createdAt: 2_000 }]);
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
    seedPluginStateEntriesForTests(
      Array.from({ length: 64 }, (_, index) => ({
        pluginId: "discord",
        namespace: "evict",
        key: `key-${String(index).padStart(2, "0")}`,
        value: index,
        createdAt: Math.floor(index / 2),
      })),
    );
    const store = syncStore("evict", 3);
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

    // One bounded expiry sweep plus eviction must not scale with the victim count.
    expect(statements.counts.delete).toBeGreaterThan(0);
    expect(statements.counts.delete).toBeLessThanOrEqual(2);
    expect(store.entries()).toEqual([
      { key: "key-62", value: 62, createdAt: 31 },
      { key: "key-63", value: 63, createdAt: 31 },
      { key: "a-protected", value: 64, createdAt: 1000 },
    ]);
  });

  it("keeps the just-registered key when namespace eviction timestamps tie", () => {
    vi.useFakeTimers({ now: 1000 });
    const store = syncStore("evict-tie-register", 1);

    store.register("z", 1);
    store.register("a", 2);

    expect(store.entries()).toEqual([{ key: "a", value: 2, createdAt: 1000 }]);
    expect(store.lookup("z")).toBeUndefined();
  });

  it("replaces an expired claim beyond the bounded cleanup batch", () => {
    vi.useFakeTimers({ now: 2_000 });
    const scope = { pluginId: "discord", namespace: "claim-expiry-batch" };
    seedPluginStateEntriesForTests([
      ...Array.from({ length: PLUGIN_STATE_EXPIRY_BATCH_ROWS }, (_, index) => ({
        ...scope,
        key: `expired-${index}`,
        value: index,
        expiresAt: 1_000,
      })),
      { ...scope, key: "target", value: -1, expiresAt: 1_500 },
    ]);
    const store = syncStore(scope.namespace, 1, true);

    expect(store.registerIfAbsent("target", 42)).toBe(true);
    expect(store.entries()).toEqual([{ key: "target", value: 42, createdAt: 2_000 }]);
  });

  it("protects a worker claim when existing rows have later timestamps", async () => {
    const store = createPluginStateKeyedStore<number>("discord", {
      namespace: "evict-worker-claim",
      maxEntries: 1,
    });
    seedPluginStateEntriesForTests([
      {
        pluginId: "discord",
        namespace: "evict-worker-claim",
        key: "z",
        value: 1,
        createdAt: Date.now() + 24 * 60 * 60 * 1000,
      },
    ]);
    const before = Date.now();
    expect(await store.registerIfAbsent("a", 2)).toBe(true);
    const after = Date.now();
    const entries = await store.entries();
    expect(entries).toMatchObject([{ key: "a", value: 2 }]);
    expect(entries[0]?.createdAt).toBeGreaterThanOrEqual(before);
    expect(entries[0]?.createdAt).toBeLessThanOrEqual(after);
    expect(await store.lookup("z")).toBeUndefined();
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
