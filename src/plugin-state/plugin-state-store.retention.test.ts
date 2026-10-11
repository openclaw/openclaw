// Plugin state retention preserves quotas, eviction order, and rollback.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { runWriteTransaction } from "./plugin-state-store.database.js";
import {
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
  registerPluginStateSequencedJournalEntry,
  resetPluginStateStoreForTests,
} from "./plugin-state-store.js";
import { PLUGIN_STATE_EXPIRY_BATCH_ROWS } from "./plugin-state-store.kernel.js";
import {
  readPluginStateRetention,
  registerPluginStateEntry,
} from "./plugin-state-store.retention.js";
import {
  clearPluginStateStoreForTests,
  seedPluginStateEntriesForTests,
} from "./plugin-state-store.test-helpers.js";

let testState: OpenClawTestState;

beforeAll(async () => {
  testState = await createOpenClawTestState({ label: "plugin-state-retention" });
});

beforeEach(() => {
  testState.applyEnv();
  clearPluginStateStoreForTests();
});

afterEach(() => {
  vi.useRealTimers();
  resetPluginStateStoreForTests({ closeDatabase: false });
});

afterAll(async () => {
  resetPluginStateStoreForTests();
  await testState.cleanup();
});

describe("plugin state keyed store", () => {
  it("shares quota and expiry facts while refreshing time and preserving sibling rows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const scope = { pluginId: "discord", namespace: "operation-retention" };
    const params = { ...scope, maxEntries: 2, overflowPolicy: "reject-new" as const };
    seedPluginStateEntriesForTests([
      { ...scope, key: "stable", value: 1 },
      { ...scope, key: "expiring", value: 2, expiresAt: 2_000 },
      { ...scope, namespace: "sibling", key: "expired", value: 3, expiresAt: 800 },
    ]);
    const current = createPluginStateSyncKeyedStore("discord", {
      namespace: scope.namespace,
      maxEntries: 2,
      overflowPolicy: "reject-new",
    });
    const sibling = createPluginStateSyncKeyedStore("discord", {
      namespace: "sibling",
      maxEntries: 2,
    });
    const counts = runWriteTransaction("register", (store) => {
      const retention = readPluginStateRetention(store.db, { ...scope, now: Date.now() });
      const statements = trackSqliteStatementExecutions(
        store.db,
        ["expiryProbe", "delete"],
        (sql) =>
          sql.startsWith('select "expires_at" from "plugin_state_entries"')
            ? "expiryProbe"
            : sql.startsWith('delete from "plugin_state_entries"')
              ? "delete"
              : null,
      );
      try {
        registerPluginStateEntry(
          store,
          { ...params, key: "stable", valueJson: "4" },
          retention,
          true,
        );
      } finally {
        statements.restore();
      }
      vi.setSystemTime(2_000);
      registerPluginStateEntry(
        store,
        { ...params, key: "stable", valueJson: "5" },
        retention,
        true,
      );
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

  it("continues bounded expiry cleanup when compound writes reuse retention facts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const scope = { pluginId: "discord", namespace: "operation-expiry-batch" };
    seedPluginStateEntriesForTests([
      { ...scope, key: "stable", value: 1 },
      ...Array.from({ length: PLUGIN_STATE_EXPIRY_BATCH_ROWS + 1 }, (_, index) => ({
        ...scope,
        key: `expired-${index}`,
        value: index,
        expiresAt: 1_000,
      })),
    ]);
    runWriteTransaction("register", (store) => {
      const retention = readPluginStateRetention(store.db, { ...scope, now: Date.now() });
      const params = {
        ...scope,
        key: "stable",
        maxEntries: 1,
        overflowPolicy: "reject-new" as const,
      };
      registerPluginStateEntry(store, { ...params, valueJson: "2" }, retention, true);
      registerPluginStateEntry(store, { ...params, valueJson: "3" }, retention, true);
    });
    vi.setSystemTime(500);
    expect(
      createPluginStateSyncKeyedStore("discord", {
        namespace: scope.namespace,
        maxEntries: 1,
      }).entries(),
    ).toEqual([{ key: "stable", value: 3, createdAt: 2_000 }]);
  });

  it("evicts oldest live entries over maxEntries with bounded database calls", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    seedPluginStateEntriesForTests(
      Array.from({ length: 64 }, (_, index) => ({
        pluginId: "discord",
        namespace: "evict",
        key: `key-${String(index).padStart(2, "0")}`,
        value: index,
        createdAt: Math.floor(index / 2),
      })),
    );
    const store = createPluginStateSyncKeyedStore("discord", { namespace: "evict", maxEntries: 3 });
    const statements = trackSqliteStatementExecutions(
      openOpenClawStateDatabase().db,
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

  it("keeps the just-registered key when namespace eviction timestamps tie", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const store = createPluginStateSyncKeyedStore<number>("discord", {
      namespace: "evict-tie-register",
      maxEntries: 1,
    });

    store.register("z", 1);
    store.register("a", 2);

    expect(store.entries()).toEqual([{ key: "a", value: 2, createdAt: 1000 }]);
    expect(store.lookup("z")).toBeUndefined();
  });

  it("keeps a same-millisecond registerIfAbsent claim in the shared native kernel", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const store = createPluginStateSyncKeyedStore<number>("discord", {
      namespace: "evict-tie-claim",
      maxEntries: 1,
    });

    expect(store.registerIfAbsent("z", 1)).toBe(true);
    expect(store.registerIfAbsent("a", 2)).toBe(true);

    expect(store.entries()).toEqual([{ key: "a", value: 2, createdAt: 1000 }]);
    expect(store.lookup("z")).toBeUndefined();
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
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: "a", value: 2 });
    expect(entries[0]?.createdAt).toBeGreaterThanOrEqual(before);
    expect(entries[0]?.createdAt).toBeLessThanOrEqual(after);
    expect(await store.lookup("z")).toBeUndefined();
  });

  it.each([true, false])(
    "sheds sequenced journal rows without evicting durable sibling state (existing cursor: %s)",
    async (existingCursor) => {
      const durableEntryCount = 37;
      seedPluginStateEntriesForTests([
        ...Array.from({ length: durableEntryCount }, (_, entryIndex) => ({
          pluginId: "memory-core",
          namespace: "durable-state",
          key: `durable-${entryIndex}`,
          value: { entryIndex },
        })),
        {
          pluginId: "memory-core",
          namespace: "memory-host.event-migration-checkpoints",
          key: "generation",
          value: { kind: "raw-checkpoint" },
        },
        ...(existingCursor
          ? [
              {
                pluginId: "memory-core",
                namespace: "memory-host.event-cursors",
                key: "workspace",
                value: { kind: "cursor", lastSequence: 9 },
              },
            ]
          : [
              {
                pluginId: "memory-core",
                namespace: "memory-host.events",
                key: "event-0000000000000010",
                value: { sequence: 10 },
              },
            ]),
        {
          pluginId: "memory-core",
          namespace: "memory-host.events",
          key: "event-0000000000000009",
          value: { sequence: 9 },
        },
      ]);

      expect(
        await registerPluginStateSequencedJournalEntry({
          pluginId: "memory-core",
          cursorOptions: {
            namespace: "memory-host.event-cursors",
            maxEntries: 1_000,
          },
          cursorKey: "workspace",
          journalOptions: { namespace: "memory-host.events", maxEntries: 1 },
          journalKeyPrefix: "event-",
          journalKeyRange: { keyStartInclusive: "event-", keyEndExclusive: "event." },
          journalValue: {},
        }),
      ).toBe(existingCursor ? 10 : 11);

      const durable = createPluginStateKeyedStore("memory-core", {
        namespace: "durable-state",
        maxEntries: durableEntryCount,
      });
      const checkpoints = createPluginStateKeyedStore("memory-core", {
        namespace: "memory-host.event-migration-checkpoints",
        maxEntries: 10_000,
        overflowPolicy: "reject-new",
      });
      const journal = createPluginStateKeyedStore("memory-core", {
        namespace: "memory-host.events",
        maxEntries: 1,
      });
      const cursor = createPluginStateKeyedStore("memory-core", {
        namespace: "memory-host.event-cursors",
        maxEntries: 1_000,
      });
      await expect(durable.lookup("durable-0")).resolves.toEqual({ entryIndex: 0 });
      await expect(checkpoints.lookup("generation")).resolves.toEqual({
        kind: "raw-checkpoint",
      });
      await expect(journal.lookup("event-0000000000000009")).resolves.toBeUndefined();
      if (existingCursor) {
        await expect(journal.lookup("event-0000000000000010")).resolves.toEqual({ sequence: 10 });
      } else {
        await expect(journal.lookup("event-0000000000000010")).resolves.toBeUndefined();
        await expect(journal.lookup("event-0000000000000011")).resolves.toEqual({ sequence: 11 });
      }
      await expect(cursor.lookup("workspace")).resolves.toEqual({
        kind: "cursor",
        lastSequence: existingCursor ? 10 : 11,
      });
    },
  );
});
