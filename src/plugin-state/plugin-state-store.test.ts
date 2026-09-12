// Plugin state store tests cover per-plugin persisted state reads and writes.
import { chmodSync, existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseByPath,
  isOpenClawStateDatabaseOpen,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  createOpenClawTestState,
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  closePluginStateDatabase,
  countPluginStateLiveEntries,
  createCorePluginStateKeyedStore,
  createCorePluginStateSyncKeyedStore,
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
  pluginStateEntriesInKeyRange,
  resetPluginStateStoreForTests,
  sweepExpiredPluginStateEntries,
} from "./plugin-state-store.js";
import {
  clearPluginStateStoreForTests,
  probePluginStateStore,
  seedPluginStateEntriesForTests,
  setMaxPluginStateEntriesPerPluginForTests,
} from "./plugin-state-store.test-helpers.js";
import { PluginStateStoreError } from "./plugin-state-store.types.js";

let testState: OpenClawTestState | undefined;

beforeAll(async () => {
  testState = await createOpenClawTestState({ label: "plugin-state-store" });
  rmSync(path.dirname(resolveOpenClawStateSqlitePath()), { recursive: true, force: true });
});

beforeEach(() => {
  testState?.applyEnv();
  clearPluginStateStoreForTests();
});

afterEach(() => {
  vi.useRealTimers();
  setMaxPluginStateEntriesPerPluginForTests(undefined);
  resetPluginStateStoreForTests({ closeDatabase: false });
});

afterAll(async () => {
  resetPluginStateStoreForTests();
  await testState?.cleanup();
});

async function withPluginStateTestState<T>(fn: () => Promise<T>): Promise<T> {
  return await fn();
}

async function expectPluginStateStoreError(
  promise: Promise<unknown>,
  expected: { code: string; operation?: string },
): Promise<void> {
  let storeError: unknown;
  try {
    await promise;
  } catch (error) {
    storeError = error;
  }
  expect(storeError).toBeInstanceOf(PluginStateStoreError);
  expect((storeError as PluginStateStoreError | undefined)?.code).toBe(expected.code);
  if (expected.operation) {
    expect((storeError as PluginStateStoreError | undefined)?.operation).toBe(expected.operation);
  }
}

describe("plugin state keyed store", () => {
  it("round-trips nested VM realm values across store instances", async () => {
    await withPluginStateTestState(async () => {
      const options = { namespace: "components", maxEntries: 10 };
      const store = createPluginStateKeyedStore("discord", options);
      const value: unknown = runInNewContext(
        '({ nested: [{ count: 1, labels: ["retained", null] }] })',
      );
      await store.register("interaction:1", value);
      closePluginStateDatabase();

      const reopened = createPluginStateSyncKeyedStore("discord", options);
      expect(reopened.lookup("interaction:1")).toEqual({
        nested: [{ count: 1, labels: ["retained", null] }],
      });
    });
  });

  it("supports synchronous keyed store callers", async () => {
    await withPluginStateTestState(async () => {
      const store = createPluginStateSyncKeyedStore<{ count: number }>("discord", {
        namespace: "sync-components",
        maxEntries: 10,
      });

      expect(store.registerIfAbsent("interaction:1", { count: 1 })).toBe(true);
      expect(store.registerIfAbsent("interaction:1", { count: 2 })).toBe(false);
      expect(store.lookup("interaction:1")).toEqual({ count: 1 });
      expect(store.entries()).toMatchObject([{ key: "interaction:1", value: { count: 1 } }]);
      expect(store.consume("interaction:1")).toEqual({ count: 1 });
      expect(store.lookup("interaction:1")).toBeUndefined();
    });
  });

  it("shares sync and async state while preserving their error contracts", async () => {
    await withPluginStateTestState(async () => {
      const options = { namespace: "shared-sync-async", maxEntries: 10 };
      const asyncStore = createPluginStateKeyedStore<{ count: number }>("discord", options);
      const syncStore = createPluginStateSyncKeyedStore<{ count: number }>("discord", options);

      syncStore.register("counter", { count: 1 });
      await expect(asyncStore.lookup("counter")).resolves.toEqual({ count: 1 });

      await expect(
        asyncStore.update("counter", (current) => ({ count: (current?.count ?? 0) + 1 })),
      ).resolves.toBe(true);
      expect(syncStore.lookup("counter")).toEqual({ count: 2 });

      expect(() => syncStore.lookup(" ")).toThrow(PluginStateStoreError);
      await expect(asyncStore.lookup(" ")).rejects.toThrow(PluginStateStoreError);
    });
  });

  it("reads a bounded sortable key range without scanning sibling keys", async () => {
    await withPluginStateTestState(async () => {
      const store = createPluginStateSyncKeyedStore<{ count: number }>("memory-core", {
        namespace: "events",
        maxEntries: 10,
      });
      store.register("workspace:event:0001", { count: 1 });
      store.register("workspace:event:0002", { count: 2 });
      store.register("workspace:other:0003", { count: 3 });

      expect(
        pluginStateEntriesInKeyRange({
          pluginId: "memory-core",
          namespace: "events",
          keyStartInclusive: "workspace:event:",
          keyEndExclusive: "workspace:event;",
          limit: 1,
          order: "desc",
        }),
      ).toMatchObject([{ key: "workspace:event:0002", value: { count: 2 } }]);
    });
  });

  it("updates a key from the current stored value", async () => {
    await withPluginStateTestState(async () => {
      setMaxPluginStateEntriesPerPluginForTests(10);
      const store = createPluginStateSyncKeyedStore<{ count: number }>("discord", {
        namespace: "sync-update",
        maxEntries: 10,
      });
      const update = store.update;

      expect(update("counter", (current) => ({ count: (current?.count ?? 0) + 1 }))).toBe(true);
      expect(update("counter", (current) => ({ count: (current?.count ?? 0) + 1 }))).toBe(true);
      expect(update("counter", () => undefined)).toBe(false);
      expect(store.lookup("counter")).toEqual({ count: 2 });
    });
  });

  it("honors explicit store env without mutating process state", async () => {
    await withOpenClawTestState(
      { label: "plugin-state-explicit-env-a", applyEnv: false },
      async (stateA) => {
        await withOpenClawTestState(
          { label: "plugin-state-explicit-env-b", applyEnv: false },
          async (stateB) => {
            const storeA = createPluginStateKeyedStore<{ owner: string }>("discord", {
              namespace: "explicit-env",
              maxEntries: 10,
              env: stateA.env,
            });
            const storeB = createPluginStateKeyedStore<{ owner: string }>("discord", {
              namespace: "explicit-env",
              maxEntries: 10,
              env: stateB.env,
            });

            await storeA.register("shared", { owner: "a" });
            await storeB.register("shared", { owner: "b" });

            await expect(storeA.lookup("shared")).resolves.toEqual({ owner: "a" });
            await expect(storeB.lookup("shared")).resolves.toEqual({ owner: "b" });
            expect(resolveOpenClawStateSqlitePath(stateA.env)).not.toBe(
              resolveOpenClawStateSqlitePath(stateB.env),
            );
          },
        );
      },
    );
  });

  it("upserts values and refreshes deterministic entry ordering", async () => {
    await withPluginStateTestState(async () => {
      vi.useFakeTimers();
      const store = createPluginStateKeyedStore<{ version: number }>("discord", {
        namespace: "components",
        maxEntries: 10,
      });
      vi.setSystemTime(1000);
      await store.register("b", { version: 1 });
      vi.setSystemTime(2000);
      await store.register("a", { version: 1 });
      vi.setSystemTime(3000);
      await store.register("b", { version: 2 });

      await expect(store.lookup("b")).resolves.toEqual({ version: 2 });
      await expect(store.entries()).resolves.toEqual([
        { key: "a", value: { version: 1 }, createdAt: 2000 },
        { key: "b", value: { version: 2 }, createdAt: 3000 },
      ]);
    });
  });

  it("refreshes the default TTL when register upserts an existing key", async () => {
    await withPluginStateTestState(async () => {
      vi.useFakeTimers();
      const store = createPluginStateKeyedStore<{ version: number }>("beam", {
        namespace: "sessions",
        maxEntries: 10,
        defaultTtlMs: 1_000,
      });
      vi.setSystemTime(1_000);
      await store.register("session", { version: 1 });
      vi.setSystemTime(1_500);
      await store.register("session", { version: 2 });

      await expect(store.entries()).resolves.toEqual([
        { key: "session", value: { version: 2 }, createdAt: 1_500, expiresAt: 2_500 },
      ]);
      vi.setSystemTime(2_100);
      await expect(store.lookup("session")).resolves.toEqual({ version: 2 });
      vi.setSystemTime(2_501);
      await expect(store.lookup("session")).resolves.toBeUndefined();
    });
  });

  it("registerIfAbsent inserts the first value and preserves live duplicates", async () => {
    await withPluginStateTestState(async () => {
      vi.useFakeTimers();
      const store = createPluginStateKeyedStore<{ version: number }>("discord", {
        namespace: "claims",
        maxEntries: 10,
      });

      vi.setSystemTime(1000);
      await expect(store.registerIfAbsent("claim", { version: 1 }, { ttlMs: 1000 })).resolves.toBe(
        true,
      );
      vi.setSystemTime(1200);
      await expect(store.registerIfAbsent("claim", { version: 2 }, { ttlMs: 5000 })).resolves.toBe(
        false,
      );

      await expect(store.lookup("claim")).resolves.toEqual({ version: 1 });
      await expect(store.entries()).resolves.toEqual([
        { key: "claim", value: { version: 1 }, createdAt: 1000, expiresAt: 2000 },
      ]);
    });
  });

  it("registerIfAbsent replaces expired keys", async () => {
    await withPluginStateTestState(async () => {
      vi.useFakeTimers();
      const store = createPluginStateKeyedStore<{ version: number }>("discord", {
        namespace: "claims-expired",
        maxEntries: 10,
      });

      vi.setSystemTime(1000);
      await expect(store.registerIfAbsent("claim", { version: 1 }, { ttlMs: 100 })).resolves.toBe(
        true,
      );
      vi.setSystemTime(1200);
      await expect(store.registerIfAbsent("claim", { version: 2 })).resolves.toBe(true);

      await expect(store.lookup("claim")).resolves.toEqual({ version: 2 });
      await expect(store.entries()).resolves.toEqual([
        { key: "claim", value: { version: 2 }, createdAt: 1200 },
      ]);
    });
  });

  it("rejects new durable rows at capacity without evicting or blocking updates", async () => {
    await withPluginStateTestState(async () => {
      vi.useFakeTimers();
      setMaxPluginStateEntriesPerPluginForTests(2);
      const store = createPluginStateKeyedStore<number>("codex", {
        namespace: "durable-bindings",
        maxEntries: 2,
        overflowPolicy: "reject-new",
      });
      vi.setSystemTime(1000);
      await store.register("first", 1);
      vi.setSystemTime(2000);
      await store.register("second", 2);

      await expect(store.register("third", 3)).rejects.toMatchObject({
        code: "PLUGIN_STATE_LIMIT_EXCEEDED",
        operation: "register",
        message: "Plugin state namespace durable-bindings for codex reached its 2-row limit.",
      });
      await expect(store.registerIfAbsent("first", 99)).resolves.toBe(false);
      vi.setSystemTime(3000);
      await expect(store.update("first", () => 10)).resolves.toBe(true);
      await expect(store.update("third", () => 3)).rejects.toMatchObject({
        code: "PLUGIN_STATE_LIMIT_EXCEEDED",
        operation: "register",
        message: "Plugin state namespace durable-bindings for codex reached its 2-row limit.",
      });
      await expect(store.entries()).resolves.toEqual([
        expect.objectContaining({ key: "second", value: 2 }),
        expect.objectContaining({ key: "first", value: 10 }),
      ]);
    });
  });

  it("deletes an entry only when the current value matches", async () => {
    await withPluginStateTestState(async () => {
      const store = createPluginStateKeyedStore<{ version: number }>("device-pair", {
        namespace: "notify-subscribers",
        maxEntries: 10,
      });
      await store.register("chat", { version: 1 });

      await expect(store.deleteIf("chat", (current) => current.version === 2)).resolves.toBe(false);
      await expect(store.lookup("chat")).resolves.toEqual({ version: 1 });
      await expect(store.deleteIf("chat", (current) => current.version === 1)).resolves.toBe(true);
      await expect(store.lookup("chat")).resolves.toBeUndefined();
    });
  });

  it("registerIfAbsent keeps plugin and namespace claims isolated", async () => {
    await withPluginStateTestState(async () => {
      const discordA = createPluginStateKeyedStore<{ owner: string }>("discord", {
        namespace: "claims-a",
        maxEntries: 10,
      });
      const discordB = createPluginStateKeyedStore<{ owner: string }>("discord", {
        namespace: "claims-b",
        maxEntries: 10,
      });
      const telegramA = createPluginStateKeyedStore<{ owner: string }>("telegram", {
        namespace: "claims-a",
        maxEntries: 10,
      });

      await expect(discordA.registerIfAbsent("same", { owner: "discord-a" })).resolves.toBe(true);
      await expect(discordB.registerIfAbsent("same", { owner: "discord-b" })).resolves.toBe(true);
      await expect(telegramA.registerIfAbsent("same", { owner: "telegram-a" })).resolves.toBe(true);
      await expect(discordA.registerIfAbsent("same", { owner: "overwrite" })).resolves.toBe(false);

      await expect(discordA.lookup("same")).resolves.toEqual({ owner: "discord-a" });
      await expect(discordB.lookup("same")).resolves.toEqual({ owner: "discord-b" });
      await expect(telegramA.lookup("same")).resolves.toEqual({ owner: "telegram-a" });
    });
  });

  it("registerIfAbsent only lets one parallel claimant win", async () => {
    await withPluginStateTestState(async () => {
      const store = createPluginStateKeyedStore<{ claimant: number }>("discord", {
        namespace: "claims-race",
        maxEntries: 10,
      });

      const attempts = await Promise.all(
        Array.from({ length: 25 }, async (_, claimant) =>
          store.registerIfAbsent("claim", { claimant }),
        ),
      );

      expect(attempts.reduce((count, attempt) => count + (attempt ? 1 : 0), 0)).toBe(1);
      const stored = await store.lookup("claim");
      if (stored === undefined) {
        throw new Error("expected winning plugin-state claim");
      }
      expect(attempts[stored.claimant]).toBe(true);
    });
  });

  it("registerIfAbsent preserves eviction and plugin row cap behavior", async () => {
    await withPluginStateTestState(async () => {
      const maxPluginEntries = 40;
      setMaxPluginStateEntriesPerPluginForTests(maxPluginEntries);
      vi.useFakeTimers();
      const evicting = createPluginStateKeyedStore<number>("discord", {
        namespace: "claims-evict",
        maxEntries: 2,
      });
      vi.setSystemTime(1000);
      await evicting.registerIfAbsent("a", 1);
      vi.setSystemTime(2000);
      await evicting.registerIfAbsent("b", 2);
      vi.setSystemTime(3000);
      await evicting.registerIfAbsent("c", 3);
      expect((await evicting.entries()).map((entry) => entry.key)).toEqual(["b", "c"]);

      seedPluginStateEntriesForTests([
        ...Array.from({ length: maxPluginEntries - 1 }, (_, entryIndex) => ({
          pluginId: "limited-plugin",
          namespace: "limit",
          key: `k-${entryIndex}`,
          value: { entryIndex },
        })),
        {
          pluginId: "limited-plugin",
          namespace: "sibling",
          key: "k-0",
          value: { sibling: true },
        },
      ]);
      const limited = createPluginStateKeyedStore("limited-plugin", {
        namespace: "limit",
        maxEntries: maxPluginEntries + 1,
      });
      const sibling = createPluginStateKeyedStore("limited-plugin", {
        namespace: "sibling",
        maxEntries: 10,
      });
      await expect(limited.registerIfAbsent("overflow", { overflow: true })).resolves.toBe(true);
      await expect(limited.lookup("k-0")).resolves.toBeUndefined();
      await expect(limited.lookup("overflow")).resolves.toEqual({ overflow: true });
      await expect(sibling.lookup("k-0")).resolves.toEqual({ sibling: true });
    });
  });

  it("returns undefined for missing lookups and consumes by deleting atomically", async () => {
    await withPluginStateTestState(async () => {
      const store = createPluginStateKeyedStore<{ ok: boolean }>("discord", {
        namespace: "components",
        maxEntries: 10,
      });

      await expect(store.lookup("missing")).resolves.toBeUndefined();
      await expect(store.consume("missing")).resolves.toBeUndefined();
      await store.register("k", { ok: true });
      await expect(store.consume("k")).resolves.toEqual({ ok: true });
      await expect(store.lookup("k")).resolves.toBeUndefined();
    });
  });

  it("deletes and clears only the targeted namespace", async () => {
    await withPluginStateTestState(async () => {
      const first = createPluginStateKeyedStore("discord", { namespace: "a", maxEntries: 10 });
      const second = createPluginStateKeyedStore("discord", { namespace: "b", maxEntries: 10 });
      await first.register("k1", { value: 1 });
      await second.register("k2", { value: 2 });

      await expect(first.delete("k1")).resolves.toBe(true);
      await expect(first.delete("k1")).resolves.toBe(false);
      await first.register("k1", { value: 1 });
      await first.clear();

      await expect(first.entries()).resolves.toStrictEqual([]);
      await expect(second.lookup("k2")).resolves.toEqual({ value: 2 });
    });
  });

  it("excludes expired entries and sweeps them", async () => {
    await withPluginStateTestState(async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      const store = createPluginStateKeyedStore("discord", {
        namespace: "ttl",
        maxEntries: 10,
        defaultTtlMs: 100,
      });
      await store.register("default", { value: "default" });
      await store.register("override", { value: "override" }, { ttlMs: 500 });

      vi.setSystemTime(1200);
      await expect(store.lookup("default")).resolves.toBeUndefined();
      await expect(store.lookup("override")).resolves.toEqual({ value: "override" });
      expect(sweepExpiredPluginStateEntries()).toBe(1);
      expect((await store.entries()).map((entry) => entry.key)).toEqual(["override"]);
    });
  });

  it("rejects plugin state ttl when expiry cannot fit in a Date timestamp", async () => {
    await withPluginStateTestState(async () => {
      const store = createPluginStateKeyedStore("discord", {
        namespace: "ttl-bounds",
        maxEntries: 10,
      });

      await expectPluginStateStoreError(store.register("huge", true, { ttlMs: Number.MAX_VALUE }), {
        code: "PLUGIN_STATE_INVALID_INPUT",
        operation: "register",
      });

      const nowSpy = vi.spyOn(Date, "now");
      try {
        nowSpy.mockReturnValue(MAX_DATE_TIMESTAMP_MS);
        await expectPluginStateStoreError(store.register("overflow", true, { ttlMs: 60_000 }), {
          code: "PLUGIN_STATE_INVALID_INPUT",
          operation: "register",
        });
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  it("segregates plugins sharing a namespace and key", async () => {
    await withPluginStateTestState(async () => {
      const discord = createPluginStateKeyedStore("discord", { namespace: "same", maxEntries: 10 });
      const telegram = createPluginStateKeyedStore("telegram", {
        namespace: "same",
        maxEntries: 10,
      });
      await discord.register("k", { plugin: "discord" });
      await telegram.register("k", { plugin: "telegram" });
      await discord.clear();

      await expect(discord.lookup("k")).resolves.toBeUndefined();
      await expect(telegram.lookup("k")).resolves.toEqual({ plugin: "telegram" });
    });
  });

  it("validates namespaces, keys, options, and JSON values before writes", async () => {
    await withPluginStateTestState(async () => {
      expect(() =>
        createPluginStateKeyedStore("discord", { namespace: "../bad", maxEntries: 10 }),
      ).toThrow(PluginStateStoreError);
      expect(() =>
        createPluginStateKeyedStore("discord", { namespace: "bad-max", maxEntries: 0 }),
      ).toThrow(PluginStateStoreError);

      const store = createPluginStateKeyedStore("discord", { namespace: "valid", maxEntries: 10 });
      await expect(store.register(" ", { ok: true })).rejects.toThrow(PluginStateStoreError);
      await expect(store.register("undefined", undefined)).rejects.toThrow(PluginStateStoreError);
      await expect(store.register("infinity", Number.POSITIVE_INFINITY)).rejects.toThrow(
        PluginStateStoreError,
      );
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      await expect(store.register("circular", circular)).rejects.toThrow(PluginStateStoreError);
      const sparse = [] as unknown[];
      sparse[1] = "hole";
      await expect(store.register("sparse", sparse)).rejects.toThrow(PluginStateStoreError);
      await expect(store.register("date", new Date())).rejects.toThrow(PluginStateStoreError);
      await expect(store.register("map", new Map([["k", "v"]]))).rejects.toThrow(
        PluginStateStoreError,
      );
      const nonEnumerable = { visible: true };
      Object.defineProperty(nonEnumerable, "hidden", { value: true, enumerable: false });
      await expect(store.register("non-enumerable", nonEnumerable)).rejects.toThrow(
        PluginStateStoreError,
      );
      // UTF-8 bytes, including JSON quotes, determine the 1 MiB boundary.
      const boundary = "é".repeat(524_287);
      await expect(store.register("large", boundary)).resolves.toBeUndefined();
      await expectPluginStateStoreError(store.register("big", `${boundary}x`), {
        code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      });

      // Key byte-length limit (512 bytes)
      await expect(store.register("k".repeat(513), { ok: true })).rejects.toThrow(
        PluginStateStoreError,
      );

      // Namespace byte-length limit (128 bytes)
      expect(() =>
        createPluginStateKeyedStore("discord", { namespace: "a".repeat(129), maxEntries: 10 }),
      ).toThrow(PluginStateStoreError);

      // JSON depth limit (64 levels)
      let deep: unknown = { leaf: true };
      for (let i = 0; i < 65; i += 1) {
        deep = { nested: deep };
      }
      await expectPluginStateStoreError(store.register("deep", deep), {
        code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      });

      // Validation errors surface the correct operation
      await expectPluginStateStoreError(store.lookup(" "), {
        code: "PLUGIN_STATE_INVALID_INPUT",
        operation: "lookup",
      });
      await expectPluginStateStoreError(store.delete(" "), {
        code: "PLUGIN_STATE_INVALID_INPUT",
        operation: "delete",
      });
    });
  });

  it("rejects reopening the same namespace with incompatible options", async () => {
    await withPluginStateTestState(async () => {
      createPluginStateKeyedStore("discord", { namespace: "same", maxEntries: 10 });
      expect(() =>
        createPluginStateKeyedStore("discord", { namespace: "same", maxEntries: 11 }),
      ).toThrow(PluginStateStoreError);
    });
  });

  it("allows core owners and reserves core-prefixed plugin ids", async () => {
    await withPluginStateTestState(async () => {
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
  });

  it("closes the cached DB handle and reopens cleanly", async () => {
    await withPluginStateTestState(async () => {
      const store = createPluginStateKeyedStore("discord", { namespace: "close", maxEntries: 10 });
      await store.register("k", { ok: true });
      const database = openOpenClawStateDatabase();
      closePluginStateDatabase();
      expect(() => database.db.exec("SELECT 1")).toThrow();
      await expect(store.lookup("k")).resolves.toEqual({ ok: true });
    });
  });

  it("keeps plugin-state reads outside the writable database lifecycle", async () => {
    await withPluginStateTestState(async () => {
      const store = createPluginStateKeyedStore("discord", {
        namespace: "read-only",
        maxEntries: 10,
      });
      await store.register("k", { ok: true });
      resetPluginStateStoreForTests();

      expect(isOpenClawStateDatabaseOpen()).toBe(false);
      await expect(store.lookup("k")).resolves.toEqual({ ok: true });
      await expect(store.entries()).resolves.toMatchObject([{ key: "k", value: { ok: true } }]);
      expect(
        pluginStateEntriesInKeyRange({
          pluginId: "discord",
          namespace: "read-only",
          keyStartInclusive: "k",
          keyEndExclusive: "l",
          limit: 1,
        }),
      ).toMatchObject([{ key: "k", value: { ok: true } }]);
      expect(countPluginStateLiveEntries("discord")).toBe(1);
      expect(isOpenClawStateDatabaseOpen()).toBe(false);
    });
  });

  it("treats a missing plugin-state database as empty without creating it", async () => {
    await withOpenClawTestState(
      { label: "plugin-state-read-only-missing", applyEnv: false },
      async (state) => {
        const store = createPluginStateKeyedStore("discord", {
          namespace: "read-only-missing",
          maxEntries: 10,
          env: state.env,
        });
        const databasePath = resolveOpenClawStateSqlitePath(state.env);

        expect(existsSync(databasePath)).toBe(false);
        await expect(store.lookup("k")).resolves.toBeUndefined();
        await expect(store.lookupMany(["k", "missing"])).resolves.toEqual([
          { ok: true, value: undefined },
          { ok: true, value: undefined },
        ]);
        await expect(store.lookupMany([])).resolves.toEqual([]);
        await expect(store.entries()).resolves.toEqual([]);
        expect(countPluginStateLiveEntries("discord", state.env)).toBe(0);
        expect(existsSync(databasePath)).toBe(false);
      },
    );
  });

  it.runIf(process.platform !== "win32")(
    "reports inaccessible explicit state directories instead of treating them as empty",
    async () => {
      await withPluginStateTestState(async () => {
        const store = createPluginStateKeyedStore("discord", {
          namespace: "inaccessible",
          maxEntries: 10,
        });
        await store.register("k", { ok: true });
        const databasePath = resolveOpenClawStateSqlitePath(testState?.env);
        closePluginStateDatabase();
        chmodSync(testState?.stateDir ?? "", 0o000);
        try {
          await expect(store.lookup("k")).rejects.toMatchObject({
            code: "PLUGIN_STATE_OPEN_FAILED",
            path: databasePath,
          });
        } finally {
          chmodSync(testState?.stateDir ?? "", 0o700);
        }
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "reuses a process-held state database when its directory becomes inaccessible",
    async () => {
      await withPluginStateTestState(async () => {
        const store = createPluginStateKeyedStore("discord", {
          namespace: "inaccessible-open-handle",
          maxEntries: 10,
        });
        await store.register("k", { ok: true });
        const database = openOpenClawStateDatabase();
        chmodSync(testState?.stateDir ?? "", 0o000);
        try {
          await expect(store.lookup("k")).resolves.toEqual({ ok: true });
          expect(database.db.isOpen).toBe(true);
        } finally {
          chmodSync(testState?.stateDir ?? "", 0o700);
        }
      });
    },
  );

  it("does not close a shared state database opened before the plugin-state probe", async () => {
    await withPluginStateTestState(async () => {
      const database = openOpenClawStateDatabase();
      const result = probePluginStateStore();

      expect(result.ok).toBe(true);
      expect(database.db.isOpen).toBe(true);
    });
  });

  it("keeps retained stores writable after the shared database owner closes its handle", async () => {
    await withPluginStateTestState(async () => {
      const store = createPluginStateKeyedStore("discord", {
        namespace: "cache-switch",
        maxEntries: 10,
      });
      await store.register("k", { ok: true });

      const syncStore = createPluginStateSyncKeyedStore("discord", {
        namespace: "cache-switch",
        maxEntries: 10,
      });
      const databasePath = resolveOpenClawStateSqlitePath();
      expect(closeOpenClawStateDatabaseByPath(databasePath)).toBe(true);
      await store.register("k", { version: 2 });
      expect(syncStore.lookup("k")).toEqual({ version: 2 });

      expect(closeOpenClawStateDatabaseByPath(databasePath)).toBe(true);
      syncStore.register("k", { version: 3 });
      await expect(store.lookup("k")).resolves.toEqual({ version: 3 });
    });
  });

  it.runIf(process.platform !== "win32")("hardens DB directory and file permissions", async () => {
    await withPluginStateTestState(async () => {
      const store = createPluginStateKeyedStore("discord", { namespace: "perms", maxEntries: 10 });
      await store.register("k", { ok: true });

      const databasePath = resolveOpenClawStateSqlitePath();
      expect(statSync(path.dirname(databasePath)).mode & 0o777).toBe(0o700);
      expect(statSync(databasePath).mode & 0o777).toBe(0o600);
    });
  });

  it("reports healthy diagnostics without stored values", async () => {
    await withPluginStateTestState(async () => {
      const result = probePluginStateStore();
      expect(result.ok).toBe(true);
      const failedSteps = result.steps.filter((step) => !step.ok);
      expect(failedSteps).toStrictEqual([]);
      expect(JSON.stringify(result)).not.toContain("probe-value");
    });
  });

  it("reports an unhealthy probe when the clock cannot produce a valid ttl expiry", async () => {
    await withPluginStateTestState(async () => {
      const nowSpy = vi.spyOn(Date, "now");
      nowSpy.mockReturnValue(MAX_DATE_TIMESTAMP_MS);

      try {
        const result = probePluginStateStore();

        expect(result.ok).toBe(false);
        expect(result.steps).toContainEqual(
          expect.objectContaining({
            name: "probe",
            ok: false,
            code: "PLUGIN_STATE_INVALID_INPUT",
          }),
        );
      } finally {
        nowSpy.mockRestore();
      }
    });
  });
});
