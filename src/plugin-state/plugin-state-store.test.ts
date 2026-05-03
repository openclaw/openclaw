import { mkdirSync, statSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closePluginStateSqliteStore,
  createCorePluginStateKeyedStore,
  createPluginStateKeyedStore,
  PluginStateStoreError,
  probePluginStateStore,
  resetPluginStateStoreForTests,
  sweepExpiredPluginStateEntries,
} from "./plugin-state-store.js";
import { resolvePluginStateDir, resolvePluginStateSqlitePath } from "./plugin-state-store.paths.js";

afterEach(() => {
  vi.useRealTimers();
  resetPluginStateStoreForTests();
});

describe("plugin state keyed store", () => {
  it("registers and looks up values across store instances", async () => {
    await withOpenClawTestState({ label: "plugin-state-roundtrip" }, async () => {
      const store = createPluginStateKeyedStore<{ count: number }>("discord", {
        maxEntries: 10,
      });
      await store.register("interaction:1", { count: 1 });

      const reopened = createPluginStateKeyedStore<{ count: number }>("discord", {
        maxEntries: 10,
      });
      await expect(reopened.lookup("interaction:1")).resolves.toEqual({ count: 1 });
    });
  });

  it("upserts values and refreshes deterministic entry ordering", async () => {
    await withOpenClawTestState({ label: "plugin-state-upsert" }, async () => {
      vi.useFakeTimers();
      const store = createPluginStateKeyedStore<{ version: number }>("discord", {
        maxEntries: 10,
      });
      vi.setSystemTime(1000);
      await store.register("b", { version: 1 });
      vi.setSystemTime(2000);
      await store.register("a", { version: 1 });
      vi.setSystemTime(3000);
      await store.register("b", { version: 2 });

      await expect(store.lookup("b")).resolves.toEqual({ version: 2 });
      await expect(store.entries()).resolves.toMatchObject([
        { key: "a", value: { version: 1 }, createdAt: 2000 },
        { key: "b", value: { version: 2 }, createdAt: 3000 },
      ]);
    });
  });

  it("returns undefined for missing lookups and consumes by deleting atomically", async () => {
    await withOpenClawTestState({ label: "plugin-state-consume" }, async () => {
      const store = createPluginStateKeyedStore<{ ok: boolean }>("discord", {
        maxEntries: 10,
      });

      await expect(store.lookup("missing")).resolves.toBeUndefined();
      await expect(store.consume("missing")).resolves.toBeUndefined();
      await store.register("k", { ok: true });
      await expect(store.consume("k")).resolves.toEqual({ ok: true });
      await expect(store.lookup("k")).resolves.toBeUndefined();
    });
  });

  it("deletes and clears only the owning plugin store", async () => {
    await withOpenClawTestState({ label: "plugin-state-clear" }, async () => {
      const discord = createPluginStateKeyedStore("discord", { maxEntries: 10 });
      const telegram = createPluginStateKeyedStore("telegram", { maxEntries: 10 });
      await discord.register("k1", { value: 1 });
      await telegram.register("k2", { value: 2 });

      await expect(discord.delete("k1")).resolves.toBe(true);
      await expect(discord.delete("k1")).resolves.toBe(false);
      await discord.register("k1", { value: 1 });
      await discord.clear();

      await expect(discord.entries()).resolves.toEqual([]);
      await expect(telegram.lookup("k2")).resolves.toEqual({ value: 2 });
    });
  });

  it("excludes expired entries and sweeps them", async () => {
    await withOpenClawTestState({ label: "plugin-state-expiry" }, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      const store = createPluginStateKeyedStore("discord", {
        maxEntries: 10,
        defaultTtlMs: 100,
      });
      await store.register("default", { value: "default" });
      await store.register("override", { value: "override" }, { ttlMs: 500 });

      vi.setSystemTime(1200);
      await expect(store.lookup("default")).resolves.toBeUndefined();
      await expect(store.lookup("override")).resolves.toEqual({ value: "override" });
      expect(sweepExpiredPluginStateEntries()).toBe(1);
      await expect(store.entries()).resolves.toMatchObject([{ key: "override" }]);
    });
  });

  it("evicts oldest live entries over maxEntries", async () => {
    await withOpenClawTestState({ label: "plugin-state-eviction" }, async () => {
      vi.useFakeTimers();
      const store = createPluginStateKeyedStore("discord", { maxEntries: 2 });
      vi.setSystemTime(1000);
      await store.register("a", 1);
      vi.setSystemTime(2000);
      await store.register("b", 2);
      vi.setSystemTime(3000);
      await store.register("c", 3);

      await expect(store.entries()).resolves.toMatchObject([{ key: "b" }, { key: "c" }]);
    });
  });

  it("rejects maxEntries above the plugin-wide live row ceiling", async () => {
    await withOpenClawTestState({ label: "plugin-state-plugin-limit" }, async () => {
      expect(() => createPluginStateKeyedStore("discord", { maxEntries: 1_001 })).toThrow(
        PluginStateStoreError,
      );
    });
  });

  it("segregates plugins sharing a key", async () => {
    await withOpenClawTestState({ label: "plugin-state-segregation" }, async () => {
      const discord = createPluginStateKeyedStore("discord", { maxEntries: 10 });
      const telegram = createPluginStateKeyedStore("telegram", {
        maxEntries: 10,
      });
      await discord.register("k", { plugin: "discord" });
      await telegram.register("k", { plugin: "telegram" });
      await discord.clear();

      await expect(discord.lookup("k")).resolves.toBeUndefined();
      await expect(telegram.lookup("k")).resolves.toEqual({ plugin: "telegram" });
    });
  });

  it("validates keys, options, and JSON values before writes", async () => {
    await withOpenClawTestState({ label: "plugin-state-validation" }, async () => {
      expect(() => createPluginStateKeyedStore("discord", { maxEntries: 0 })).toThrow(
        PluginStateStoreError,
      );
      expect(() => createPluginStateKeyedStore("discord", { maxEntries: 1_001 })).toThrow(
        PluginStateStoreError,
      );

      const defaultStore = createPluginStateKeyedStore("default-plugin");
      await defaultStore.register("default-options", { ok: true });
      await expect(defaultStore.lookup("default-options")).resolves.toEqual({ ok: true });

      const store = createPluginStateKeyedStore("discord", { maxEntries: 10 });
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
      await expect(store.register("big", "x".repeat(65_537))).rejects.toMatchObject({
        code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      });

      // Key byte-length limit (512 bytes)
      await expect(store.register("k".repeat(513), { ok: true })).rejects.toThrow(
        PluginStateStoreError,
      );

      // JSON depth limit (64 levels)
      let deep: unknown = { leaf: true };
      for (let i = 0; i < 65; i += 1) {
        deep = { nested: deep };
      }
      await expect(store.register("deep", deep)).rejects.toMatchObject({
        code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      });

      // Validation errors surface the correct operation
      await expect(store.lookup(" ")).rejects.toMatchObject({
        code: "PLUGIN_STATE_INVALID_INPUT",
        operation: "lookup",
      });
      await expect(store.delete(" ")).rejects.toMatchObject({
        code: "PLUGIN_STATE_INVALID_INPUT",
        operation: "delete",
      });
    });
  });

  it("rejects reopening the same plugin store with incompatible options", async () => {
    await withOpenClawTestState({ label: "plugin-state-option-consistency" }, async () => {
      createPluginStateKeyedStore("discord", { maxEntries: 10 });
      expect(() => createPluginStateKeyedStore("discord", { maxEntries: 11 })).toThrow(
        PluginStateStoreError,
      );
    });
  });

  it("allows core owners and reserves core-prefixed plugin ids", async () => {
    await withOpenClawTestState({ label: "plugin-state-core" }, async () => {
      const store = createCorePluginStateKeyedStore<{ stopped: boolean }>({
        ownerId: "core:channel-intent",
        maxEntries: 10,
      });
      await store.register("telegram:personal", { stopped: true });
      await expect(store.lookup("telegram:personal")).resolves.toEqual({ stopped: true });
      expect(() => createPluginStateKeyedStore("core:not-a-plugin", { maxEntries: 10 })).toThrow(
        PluginStateStoreError,
      );
      expect(() => createPluginStateKeyedStore("__proto__", { maxEntries: 10 })).toThrow(
        PluginStateStoreError,
      );
    });
  });

  it("closes the cached DB handle and reopens cleanly", async () => {
    await withOpenClawTestState({ label: "plugin-state-close" }, async () => {
      const store = createPluginStateKeyedStore("discord", { maxEntries: 10 });
      await store.register("k", { ok: true });
      closePluginStateSqliteStore();
      await expect(store.lookup("k")).resolves.toEqual({ ok: true });
    });
  });

  it.runIf(process.platform !== "win32")("hardens DB directory and file permissions", async () => {
    await withOpenClawTestState({ label: "plugin-state-permissions" }, async () => {
      const store = createPluginStateKeyedStore("discord", { maxEntries: 10 });
      await store.register("k", { ok: true });

      expect(statSync(resolvePluginStateDir()).mode & 0o777).toBe(0o700);
      expect(statSync(resolvePluginStateSqlitePath()).mode & 0o777).toBe(0o600);
    });
  });

  it("reports healthy diagnostics without stored values", async () => {
    await withOpenClawTestState({ label: "plugin-state-probe" }, async () => {
      const result = probePluginStateStore();
      expect(result.ok).toBe(true);
      expect(result.steps.every((step) => step.ok)).toBe(true);
      expect(JSON.stringify(result)).not.toContain("probe-value");
    });
  });

  it("throws on unsupported future schema versions", async () => {
    await withOpenClawTestState({ label: "plugin-state-schema" }, async () => {
      mkdirSync(resolvePluginStateDir(), { recursive: true });
      const { DatabaseSync } = requireNodeSqlite();
      const db = new DatabaseSync(resolvePluginStateSqlitePath());
      db.exec("PRAGMA user_version = 2;");
      db.close();

      const store = createPluginStateKeyedStore("discord", { maxEntries: 10 });
      await expect(store.register("k", { ok: true })).rejects.toMatchObject({
        code: "PLUGIN_STATE_SCHEMA_UNSUPPORTED",
      });
    });
  });
});
