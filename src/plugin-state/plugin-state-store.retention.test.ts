// Plugin state retention preserves quotas, eviction order, and rollback.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createPluginStateKeyedStore,
  registerPluginStateSyncSequencedJournalEntry,
  resetPluginStateStoreForTests,
  sweepExpiredPluginStateEntries,
} from "./plugin-state-store.js";
import {
  clearPluginStateStoreForTests,
  seedPluginStateEntriesForTests,
  setMaxPluginStateEntriesPerPluginForTests,
} from "./plugin-state-store.test-helpers.js";
import { PluginStateStoreError } from "./plugin-state-store.types.js";

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
  setMaxPluginStateEntriesPerPluginForTests(undefined);
  resetPluginStateStoreForTests({ closeDatabase: false });
});

afterAll(async () => {
  resetPluginStateStoreForTests();
  await testState.cleanup();
});

describe("plugin state keyed store", () => {
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
    const store = createPluginStateKeyedStore("discord", { namespace: "evict", maxEntries: 3 });
    const statements = trackSqliteStatementExecutions(
      openOpenClawStateDatabase().db,
      ["delete"],
      (sql) => (sql.startsWith('delete from "plugin_state_entries"') ? "delete" : null),
    );
    try {
      await store.register("a-protected", 64);
    } finally {
      statements.restore();
    }

    // One bounded expiry sweep plus eviction must not scale with the victim count.
    expect(statements.counts.delete).toBeLessThanOrEqual(2);
    expect(await store.entries()).toEqual([
      { key: "key-62", value: 62, createdAt: 31 },
      { key: "key-63", value: 63, createdAt: 31 },
      { key: "a-protected", value: 64, createdAt: 1000 },
    ]);
  });

  it("keeps the just-registered key when namespace eviction timestamps tie", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const store = createPluginStateKeyedStore<number>("discord", {
      namespace: "evict-tie-register",
      maxEntries: 1,
    });

    await store.register("z", 1);
    await store.register("a", 2);

    await expect(store.entries()).resolves.toEqual([{ key: "a", value: 2, createdAt: 1000 }]);
    await expect(store.lookup("z")).resolves.toBeUndefined();
  });

  it.each([3, 5])(
    "enforces plugin quota without a redundant namespace count at maxEntries %i",
    async (maxEntries) => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      setMaxPluginStateEntriesPerPluginForTests(3);
      const pluginId = "quota-plugin";
      const namespace = "quota";
      seedPluginStateEntriesForTests([
        ...["a-protected", "b", "c", "d", "e", "z"].map((key) => ({
          pluginId,
          namespace,
          key,
          value: key,
          createdAt: 1000,
        })),
        { pluginId, namespace: "sibling", key: "peer", value: "sibling", createdAt: 1 },
        {
          pluginId: "foreign-plugin",
          namespace,
          key: "peer",
          value: "foreign",
          createdAt: 1,
        },
      ]);
      const store = createPluginStateKeyedStore<string>(pluginId, { namespace, maxEntries });
      const sibling = createPluginStateKeyedStore<string>(pluginId, {
        namespace: "sibling",
        maxEntries: 3,
      });
      const foreign = createPluginStateKeyedStore<string>("foreign-plugin", {
        namespace,
        maxEntries,
      });
      const statements = trackSqliteStatementExecutions(
        openOpenClawStateDatabase().db,
        ["namespace", "plugin"],
        (sql) => {
          if (!sql.startsWith('select count(*) as "count" from "plugin_state_entries"')) {
            return null;
          }
          return sql.includes('"namespace" = ?') ? "namespace" : "plugin";
        },
      );
      try {
        await store.register("a-protected", "updated");
      } finally {
        statements.restore();
      }

      await expect(store.entries()).resolves.toEqual([
        { key: "a-protected", value: "updated", createdAt: 1000 },
        { key: "z", value: "z", createdAt: 1000 },
      ]);
      await expect(sibling.entries()).resolves.toEqual([
        { key: "peer", value: "sibling", createdAt: 1 },
      ]);
      await expect(foreign.entries()).resolves.toEqual([
        { key: "peer", value: "foreign", createdAt: 1 },
      ]);
      expect(statements.counts.namespace).toBe(0);
      expect(statements.counts.plugin).toBe(1);
    },
  );

  it("keeps a same-millisecond registerIfAbsent claim during namespace eviction", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const store = createPluginStateKeyedStore<number>("discord", {
      namespace: "evict-tie-claim",
      maxEntries: 1,
    });

    await expect(store.registerIfAbsent("z", 1)).resolves.toBe(true);
    await expect(store.registerIfAbsent("a", 2)).resolves.toBe(true);

    await expect(store.entries()).resolves.toEqual([{ key: "a", value: 2, createdAt: 1000 }]);
    await expect(store.lookup("z")).resolves.toBeUndefined();
  });

  it("evicts current namespace rows when sibling namespaces consume plugin row budget", async () => {
    const maxPluginEntries = 40;
    setMaxPluginStateEntriesPerPluginForTests(maxPluginEntries);
    seedPluginStateEntriesForTests([
      ...Array.from({ length: maxPluginEntries - 11 }, (_, entryIndex) => ({
        pluginId: "telegram",
        namespace: "telegram.message-cache",
        key: `k-${entryIndex}`,
        value: { kind: "message", entryIndex },
      })),
      ...Array.from({ length: 11 }, (_, entryIndex) => ({
        pluginId: "telegram",
        namespace: "telegram.topic-name-cache",
        key: `topic-${entryIndex}`,
        value: { kind: "topic", entryIndex },
      })),
    ]);

    const messageStore = createPluginStateKeyedStore("telegram", {
      namespace: "telegram.message-cache",
      maxEntries: maxPluginEntries,
    });
    const topicStore = createPluginStateKeyedStore("telegram", {
      namespace: "telegram.topic-name-cache",
      maxEntries: 100,
    });

    await expect(
      messageStore.register("new-message", { kind: "message", fresh: true }),
    ).resolves.toBeUndefined();

    await expect(messageStore.lookup("k-0")).resolves.toBeUndefined();
    await expect(messageStore.lookup("new-message")).resolves.toEqual({
      kind: "message",
      fresh: true,
    });
    await expect(topicStore.lookup("topic-0")).resolves.toEqual({
      kind: "topic",
      entryIndex: 0,
    });
    await expect(messageStore.entries()).resolves.toHaveLength(maxPluginEntries - 11);
    await expect(topicStore.entries()).resolves.toHaveLength(11);
  });

  it.each([true, false])(
    "sheds sequenced journal rows without evicting durable sibling state (existing cursor: %s)",
    async (existingCursor) => {
      const maxPluginEntries = 40;
      setMaxPluginStateEntriesPerPluginForTests(maxPluginEntries);
      seedPluginStateEntriesForTests([
        ...Array.from({ length: maxPluginEntries - 3 }, (_, entryIndex) => ({
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
                value: { kind: "cursor", lastSequence: 1 },
              },
            ]
          : [
              {
                pluginId: "memory-core",
                namespace: "memory-host.events",
                key: "event-2",
                value: { sequence: 2 },
              },
            ]),
        {
          pluginId: "memory-core",
          namespace: "memory-host.events",
          key: "event-1",
          value: { sequence: 1 },
        },
      ]);

      expect(
        registerPluginStateSyncSequencedJournalEntry({
          pluginId: "memory-core",
          cursorOptions: {
            namespace: "memory-host.event-cursors",
            maxEntries: 1_000,
          },
          cursorKey: "workspace",
          journalOptions: { namespace: "memory-host.events", maxEntries: 10_000 },
          initialSequence: existingCursor ? 0 : 2,
          journalKey: (sequence) => `event-${sequence}`,
          journalValue: (sequence) => ({ sequence }),
        }),
      ).toBe(existingCursor ? 2 : 3);

      const durable = createPluginStateKeyedStore("memory-core", {
        namespace: "durable-state",
        maxEntries: maxPluginEntries,
      });
      const checkpoints = createPluginStateKeyedStore("memory-core", {
        namespace: "memory-host.event-migration-checkpoints",
        maxEntries: 10_000,
        overflowPolicy: "reject-new",
      });
      const journal = createPluginStateKeyedStore("memory-core", {
        namespace: "memory-host.events",
        maxEntries: 10_000,
      });
      const cursor = createPluginStateKeyedStore("memory-core", {
        namespace: "memory-host.event-cursors",
        maxEntries: 1_000,
      });
      await expect(durable.lookup("durable-0")).resolves.toEqual({ entryIndex: 0 });
      await expect(checkpoints.lookup("generation")).resolves.toEqual({
        kind: "raw-checkpoint",
      });
      await expect(journal.lookup("event-1")).resolves.toBeUndefined();
      if (existingCursor) {
        await expect(journal.lookup("event-2")).resolves.toEqual({ sequence: 2 });
      } else {
        await expect(journal.lookup("event-2")).resolves.toBeUndefined();
        await expect(journal.lookup("event-3")).resolves.toEqual({ sequence: 3 });
      }
      await expect(cursor.lookup("workspace")).resolves.toEqual({
        kind: "cursor",
        lastSequence: existingCursor ? 2 : 3,
      });
    },
  );

  it("leaves room for Telegram sibling namespaces at their persistent budgets", async () => {
    seedPluginStateEntriesForTests([
      ...Array.from({ length: 3_000 }, (_, entryIndex) => ({
        pluginId: "telegram",
        namespace: "telegram.message-cache",
        key: `message-${entryIndex}`,
        value: { kind: "message", entryIndex },
      })),
      ...Array.from({ length: 2_047 }, (_, entryIndex) => ({
        pluginId: "telegram",
        namespace: "telegram.topic-name-cache",
        key: `topic-${entryIndex}`,
        value: { kind: "topic", updatedAt: entryIndex },
      })),
      ...Array.from({ length: 127 }, (_, entryIndex) => ({
        pluginId: "telegram",
        namespace: "telegram.bot-info-cache",
        key: `bot-${entryIndex}`,
        value: { kind: "bot-info", fetchedAt: String(entryIndex) },
      })),
    ]);

    const topicStore = createPluginStateKeyedStore("telegram", {
      namespace: "telegram.topic-name-cache",
      maxEntries: 2_048,
    });
    const botInfoStore = createPluginStateKeyedStore("telegram", {
      namespace: "telegram.bot-info-cache",
      maxEntries: 128,
    });

    await expect(
      topicStore.register("topic-final", { kind: "topic", updatedAt: 2_048 }),
    ).resolves.toBeUndefined();
    await expect(
      botInfoStore.register("default", { kind: "bot-info", fetchedAt: "now" }),
    ).resolves.toBeUndefined();

    await expect(topicStore.lookup("topic-final")).resolves.toEqual({
      kind: "topic",
      updatedAt: 2_048,
    });
    await expect(botInfoStore.lookup("default")).resolves.toEqual({
      kind: "bot-info",
      fetchedAt: "now",
    });
  });

  it("rolls back plugin overflow when the current namespace cannot shed enough rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const maxPluginEntries = 3;
    setMaxPluginStateEntriesPerPluginForTests(maxPluginEntries);
    seedPluginStateEntriesForTests([
      ...Array.from({ length: maxPluginEntries }, (_, entryIndex) => ({
        pluginId: "telegram",
        namespace: "telegram.topic-name-cache",
        key: `topic-${entryIndex}`,
        value: { entryIndex },
      })),
      ...Array.from({ length: 5 }, (_, entryIndex) => ({
        pluginId: "telegram",
        namespace: "telegram.message-cache",
        key: `old-${entryIndex}`,
        value: { entryIndex },
        createdAt: entryIndex,
      })),
      {
        pluginId: "telegram",
        namespace: "telegram.message-cache",
        key: "expired",
        value: "expired",
        expiresAt: 1000,
      },
    ]);

    const messageStore = createPluginStateKeyedStore("telegram", {
      namespace: "telegram.message-cache",
      maxEntries: maxPluginEntries,
    });
    const topicStore = createPluginStateKeyedStore("telegram", {
      namespace: "telegram.topic-name-cache",
      maxEntries: maxPluginEntries,
    });
    const originalMessages = await messageStore.entries();
    const originalTopics = await topicStore.entries();

    const registration = messageStore.register("new-message", { fresh: true });
    await expect(registration).rejects.toBeInstanceOf(PluginStateStoreError);
    await expect(registration).rejects.toMatchObject({
      code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      operation: "register",
    });
    await expect(messageStore.lookup("new-message")).resolves.toBeUndefined();
    await expect(topicStore.lookup("topic-0")).resolves.toEqual({ entryIndex: 0 });
    await expect(messageStore.entries()).resolves.toEqual(originalMessages);
    await expect(topicStore.entries()).resolves.toEqual(originalTopics);
    expect(sweepExpiredPluginStateEntries()).toBe(1);
  });
});
