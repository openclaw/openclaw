import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, assert, describe, expect, vi } from "vitest";
import type { EngineConnection } from "../infra/sql-connection.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  openOpenClawStateDatabase,
  isOpenClawStateDatabaseOpen,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createPluginBlobStoreForTests,
  resetPluginBlobStoreForTests,
  type OpenBlobStoreOptions,
} from "./plugin-blob-store.js";
import { createPluginBlobKernelStore } from "./plugin-blob-store.test-helpers.js";
import type { PluginBlobStoreWithReceipts } from "./plugin-blob-store.types.js";
import { PluginBlobStoreError } from "./plugin-blob-store.types.js";
import { stateTest } from "./plugin-state-fixtures.test-support.js";

const limit = (promise: Promise<unknown>) =>
  expect(promise).rejects.toMatchObject({ code: "PLUGIN_BLOB_LIMIT_EXCEEDED" });
const corrupt = (promise: Promise<unknown>, operation: string) =>
  expect(promise).rejects.toMatchObject({ code: "PLUGIN_BLOB_CORRUPT", operation });
function seedCorrupt(db: EngineConnection, createdAt: number, expiresAt: number | null) {
  db.prepare(
    `INSERT INTO plugin_blob_entries
          (plugin_id, namespace, entry_key, metadata_json, blob, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("diffs", "artifacts", "corrupt", "{", Buffer.from([7]), createdAt, expiresAt);
}

const bytes = (...values: number[]) => new Uint8Array(values);
type BlobReader = Pick<PluginBlobStoreWithReceipts<unknown>, "lookup">;
async function expectBlob(store: BlobReader, key: string, expected: object) {
  await expect(store.lookup(key)).resolves.toMatchObject(expected);
}

const defaults = {
  namespace: "artifacts",
  maxEntries: 3,
  maxBytesPerEntry: 16,
  maxBytesPerNamespace: 32,
};
const open = <T>(
  env: NodeJS.ProcessEnv,
  overrides: Partial<OpenBlobStoreOptions> = {},
  owner = "diffs",
) => createPluginBlobStoreForTests<T>(owner, { ...defaults, ...overrides }, env);
const kernel = <T>(env: NodeJS.ProcessEnv, overrides: Partial<OpenBlobStoreOptions> = {}) =>
  createPluginBlobKernelStore<T>("diffs", { ...defaults, ...overrides, env });
afterEach(async () => {
  vi.useRealTimers();
  await closeOpenClawStateDatabaseAsync();
  resetPluginBlobStoreForTests();
});

describe("plugin-blob-store", () => {
  const it = stateTest("plugin-blob-store");
  it("rejects quota overflow without disturbing existing rows", async ({ state }) => {
    const store = open<{ order: number }>(state.env, {
      maxEntries: 1,
      maxBytesPerEntry: 4,
      maxBytesPerNamespace: 4,
      overflowPolicy: "reject-new",
    });
    await store.register("one", bytes(1, 2), { order: 1 });
    await limit(store.register("two", bytes(3), { order: 2 }));
    expect((await store.entries()).map((entry) => entry.key)).toEqual(["one"]);
    await store.register("one", bytes(4, 5, 6, 7), { order: 3 });
    await expectBlob(store, "one", { sizeBytes: 4 });
    await store.register("one", bytes(), { order: 4 });
    await store.register("one", bytes(8), { order: 5 });
    await expectBlob(store, "one", { bytes: bytes(8), metadata: { order: 5 } });

    const byteStore = open<{ order: number }>(state.env, {
      namespace: "byte-limit",
      maxBytesPerEntry: 3,
      maxBytesPerNamespace: 4,
      overflowPolicy: "reject-new",
    });
    await byteStore.register("one", bytes(1, 2), { order: 1 });
    await byteStore.register("two", bytes(3, 4), { order: 2 });
    await limit(byteStore.register("one", bytes(5, 6, 7), { order: 3 }));
    await expectBlob(byteStore, "one", { bytes: bytes(1, 2), metadata: { order: 1 } });
    await expectBlob(byteStore, "two", { bytes: bytes(3, 4) });
    await expectBlob(store, "one", { bytes: bytes(8), metadata: { order: 5 } });
  });

  it("evicts the oldest namespace row while protecting the current write", async ({ state }) => {
    vi.useFakeTimers({ now: 1_000 });

    const store = kernel<{ order: number }>(state.env, { maxEntries: 2 });
    await store.register("one", bytes(1), { order: 1 });
    vi.setSystemTime(1_001);
    await store.register("two", bytes(2), { order: 2 });
    vi.setSystemTime(1_002);
    await store.register("three", bytes(3), { order: 3 });
    expect((await store.entries()).map((entry) => entry.key)).toEqual(["two", "three"]);

    await store.clear();
    await store.register("zeta", bytes(1), { order: 1 });
    await store.register("alpha", bytes(2), { order: 2 });
    vi.setSystemTime(999);
    await store.register("protected", bytes(3), { order: 3 });
    expect((await store.entries()).map((entry) => entry.key)).toEqual(["protected", "zeta"]);
  });

  it("keeps expired metadata owner-managed across later writes", async ({ state }) => {
    vi.useFakeTimers({ now: 2_000 });

    const store = kernel<{ order: number }>(state.env);
    await store.register("one", bytes(1), { order: 1 }, { ttlMs: 10 });
    vi.setSystemTime(2_011);
    await store.register("two", bytes(2), { order: 2 }, { ttlMs: 10 });
    await expect(store.deleteExpiredKey("one")).resolves.toEqual({
      key: "one",
      metadata: { order: 1 },
      sizeBytes: 1,
      createdAt: 2_000,
      expiresAt: 2_010,
    });
    await expect(store.deleteExpiredKey("two")).resolves.toBeUndefined();
    await expect(store.deleteExpired()).resolves.toEqual([]);
    await expectBlob(store, "two", { metadata: { order: 2 } });
    vi.setSystemTime(2_022);
    await expect(store.deleteExpired()).resolves.toEqual([
      { key: "two", metadata: { order: 2 }, sizeBytes: 1, createdAt: 2_011, expiresAt: 2_021 },
    ]);
    await expect(store.deleteExpired()).resolves.toEqual([]);
  });

  it("counts expired rows toward physical limits without evicting cleanup metadata", async ({
    state,
  }) => {
    vi.useFakeTimers({ now: 2_500 });

    for (const [index, overflowPolicy] of (["reject-new", "evict-oldest"] as const).entries()) {
      const store = kernel<{ path: string }>(state.env, {
        namespace: overflowPolicy,
        maxEntries: 1,
        overflowPolicy,
      });
      const old = { path: index === 0 ? "reject-old" : "evict-old" };
      const fresh = { path: index === 0 ? "reject-new" : "evict-new" };
      await store.register("expired", bytes(1 + 2 * index), old, { ttlMs: 10 });
      vi.setSystemTime(2_511 + 11 * index);
      await limit(store.register("fresh", bytes(2 + 2 * index), fresh));
      await expect(store.deleteExpiredKey("expired")).resolves.toMatchObject({ metadata: old });
      if (overflowPolicy === "reject-new") {
        await expect(store.register("fresh", bytes(2), fresh)).resolves.toBeUndefined();
      }
    }

    const replacingStore = kernel<{ path: string }>(state.env, {
      namespace: "replacing",
      maxBytesPerEntry: 10,
      maxBytesPerNamespace: 10,
      overflowPolicy: "evict-oldest",
    });
    await replacingStore.register(
      "expired",
      new Uint8Array(5),
      { path: "replace-old" },
      { ttlMs: 10 },
    );
    await replacingStore.register("target", new Uint8Array(4), { path: "target-old" });
    vi.setSystemTime(2_533);

    await limit(replacingStore.register("target", new Uint8Array(6), { path: "target-new" }));
    await expectBlob(replacingStore, "target", {
      metadata: { path: "target-old" },
      sizeBytes: 4,
    });
    await expect(replacingStore.deleteExpiredKey("expired")).resolves.toMatchObject({
      metadata: { path: "replace-old" },
    });
  });

  it("validates hard limits and consistent namespace options", async ({ state }) => {
    const store = open(state.env, { maxBytesPerEntry: 2 });
    await expect(store.register("big", bytes(1, 2, 3), {})).rejects.toBeInstanceOf(
      PluginBlobStoreError,
    );
    expect(() => open(state.env, { maxBytesPerEntry: 3 })).toThrow(/incompatible options/);
  });

  it.each(["reject-new", "evict-oldest"] as const)(
    "enforces the physical plugin row limit across namespaces with %s",
    async (overflowPolicy) => {
      vi.useFakeTimers({ now: 6_000 });
      await withOpenClawTestState({ label: "plugin-blob-plugin-quota" }, async (state) => {
        const store = kernel<{ owner: string }>(state.env, { overflowPolicy });
        const emptyNamespace = kernel<{ owner: string }>(state.env, {
          namespace: "empty",
          overflowPolicy,
        });
        const { db } = openOpenClawStateDatabase({ env: state.env });
        db.exec(`WITH RECURSIVE entries(n) AS (
          VALUES (1) UNION ALL SELECT n + 1 FROM entries WHERE n < 49999
        ) INSERT INTO plugin_blob_entries
          (plugin_id, namespace, entry_key, metadata_json, blob, created_at, expires_at)
          SELECT 'diffs', 'sibling', 'expired-' || n, '{"owner":"sibling"}', zeroblob(0), 1, 2
          FROM entries`);
        await store.register("one", bytes(1), { owner: "one" });
        await store.register("one", bytes(1, 2), { owner: "replacement" });

        const write = store.register("two", bytes(3), { owner: "two" });
        if (overflowPolicy === "reject-new") {
          await limit(write);
          await expectBlob(store, "one", { sizeBytes: 2, metadata: { owner: "replacement" } });
          await expect(store.lookup("two")).resolves.toBeUndefined();
        } else {
          await expect(write).resolves.toBeUndefined();
          await expect(store.lookup("one")).resolves.toBeUndefined();
          await expectBlob(store, "two", { metadata: { owner: "two" } });
        }

        await limit(emptyNamespace.register("blocked", bytes(4), { owner: "blocked" }));
        await expect(emptyNamespace.lookup("blocked")).resolves.toBeUndefined();
        expect(
          db
            .prepare("SELECT COUNT(*) AS count FROM plugin_blob_entries WHERE plugin_id = ?")
            .get("diffs"),
        ).toEqual({ count: 50_000 });
        const sibling = kernel<{ owner: string }>(state.env, {
          namespace: "sibling",
          overflowPolicy,
        });
        await expect(sibling.deleteExpiredKey("expired-1")).resolves.toMatchObject({
          metadata: { owner: "sibling" },
          sizeBytes: 0,
        });
      });
    },
  );

  it("isolates plugin ids and namespaces and persists across reopen", async ({ state }) => {
    const diffs = open<{ owner: string }>(state.env);
    const otherPlugin = open<{ owner: string }>(state.env, {}, "other");
    const otherNamespace = open<{ owner: string }>(state.env, { namespace: "other-artifacts" });
    await diffs.register("same", bytes(1), { owner: "diffs" });

    await expect(otherPlugin.lookup("same")).resolves.toBeUndefined();
    await expect(otherNamespace.lookup("same")).resolves.toBeUndefined();
    await closeOpenClawStateDatabaseAsync();
    resetPluginBlobStoreForTests();

    const reopened = open<{ owner: string }>(state.env);
    await expectBlob(reopened, "same", { metadata: { owner: "diffs" }, bytes: bytes(1) });
  });

  it("publishes persisted timestamps and refuses duplicate registration without replacing data", async ({
    state,
  }) => {
    const store = open<{ version: number }>(state.env);
    const expectStored = (receipt: object, byte: number, version: number) =>
      expect(store.lookup("stable")).resolves.toEqual({
        ...receipt,
        key: "stable",
        bytes: bytes(byte),
        sizeBytes: 1,
        metadata: { version },
      });
    const startedAt = Date.now();
    const receipt = await store.registerIfAbsentWithReceipt(
      "stable",
      bytes(1),
      { version: 1 },
      { ttlMs: 60_000 },
    );
    assert.isDefined(receipt);
    expect(receipt.createdAt).toBeGreaterThanOrEqual(startedAt);
    expect(receipt.createdAt).toBeLessThanOrEqual(Date.now());
    expect(receipt.expiresAt).toBe(receipt.createdAt + 60_000);
    await expect(
      store.registerIfAbsentWithReceipt("stable", bytes(2), { version: 2 }),
    ).resolves.toBeUndefined();
    await expect(store.registerIfAbsent("stable", bytes(3), { version: 3 })).resolves.toBe(false);
    await expectStored(receipt, 1, 1);

    await store.delete("stable");
    const replacement = await store.registerIfAbsentWithReceipt("stable", bytes(4), {
      version: 4,
    });
    assert.isDefined(replacement);
    expect(replacement).toEqual({ createdAt: expect.any(Number) });
    await expectStored(replacement, 4, 4);
  });

  it("keeps an expired stable key occupied until the owner claims its metadata", async ({
    state,
  }) => {
    vi.useFakeTimers({ now: 4_000 });

    const store = kernel<{ path: string }>(state.env);
    await expect(
      store.registerIfAbsent("stable", bytes(1), { path: "old" }, { ttlMs: 10 }),
    ).resolves.toBe(true);

    vi.setSystemTime(4_011);
    await expect(store.registerIfAbsent("stable", bytes(2), { path: "new" })).resolves.toBe(false);
    await expect(store.deleteExpiredKey("stable")).resolves.toMatchObject({
      key: "stable",
      metadata: { path: "old" },
    });
    await expect(store.registerIfAbsent("stable", bytes(2), { path: "new" })).resolves.toBe(true);
    await expectBlob(store, "stable", { metadata: { path: "new" }, bytes: bytes(2) });
  });

  it("rolls back a rejected replacement and rejects corrupt metadata", async ({ state }) => {
    const store = open<{ ok: boolean }>(state.env, {
      maxBytesPerEntry: 3,
      maxBytesPerNamespace: 3,
      overflowPolicy: "reject-new",
    });
    await store.register("stable", bytes(1, 2), { ok: true });
    await limit(store.register("stable", bytes(1, 2, 3, 4), { ok: false }));
    await expectBlob(store, "stable", { metadata: { ok: true }, bytes: bytes(1, 2) });

    const { db } = openOpenClawStateDatabase({ env: state.env });
    seedCorrupt(db, 1, null);
    await corrupt(store.lookup("corrupt"), "lookup");
    await corrupt(store.entries(), "entries");
  });

  it("preserves expired rows when owner metadata is corrupt", async ({ state }) => {
    vi.useFakeTimers({ now: 5_000 });

    const store = kernel<{ path: string }>(state.env);
    await store.register("valid", bytes(1), { path: "valid" }, { ttlMs: 10 });
    const { db } = openOpenClawStateDatabase({ env: state.env });
    seedCorrupt(db, 5_000, 5_010);

    vi.setSystemTime(5_011);
    await corrupt(store.deleteExpired(), "sweep");
    expect(
      db
        .prepare(
          `SELECT entry_key FROM plugin_blob_entries
             WHERE plugin_id = ? AND namespace = ? ORDER BY entry_key`,
        )
        .all("diffs", "artifacts"),
    ).toEqual([{ entry_key: "corrupt" }, { entry_key: "valid" }]);

    await corrupt(store.deleteExpiredKey("corrupt"), "sweep");
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM plugin_blob_entries
             WHERE plugin_id = ? AND namespace = ? AND entry_key = ?`,
        )
        .get("diffs", "artifacts", "corrupt"),
    ).toEqual({ count: 1 });
  });
});

describe("plugin-blob-store.readonly", () => {
  const it = stateTest("plugin-blob-readonly", false);
  const createStore = (env: NodeJS.ProcessEnv) =>
    open<{ version: number }>(env, { namespace: "readonly" });

  it("returns empty reads without creating an absent database", async ({ state }) => {
    const store = createStore(state.env);
    const databasePath = resolveOpenClawStateSqlitePath(state.env);

    await expect(store.lookup("missing")).resolves.toBeUndefined();
    await expect(store.entries()).resolves.toEqual([]);
    expect(existsSync(path.dirname(databasePath))).toBe(false);
    expect(isOpenClawStateDatabaseOpen(databasePath)).toBe(false);
  });

  it("keeps an active writer's uncommitted changes out of blob reads", async ({ state }) => {
    const store = createStore(state.env);
    await store.register("saved", bytes(1), { version: 1 });
    const { db } = openOpenClawStateDatabase({ env: state.env });
    db.exec("BEGIN IMMEDIATE; DELETE FROM plugin_blob_entries;");
    try {
      const entry = await store.lookup("saved");
      expect(entry).toMatchObject({ metadata: { version: 1 }, bytes: bytes(1) });
      entry!.bytes[0] = 9;
      await expectBlob(store, "saved", { bytes: bytes(1) });
      await expect(store.entries()).resolves.toMatchObject([{ key: "saved" }]);
    } finally {
      db.exec("ROLLBACK");
    }
    await expectBlob(store, "saved", { metadata: { version: 1 } });
  });

  it("rejects a newer schema through warm acquisition", async ({ state }) => {
    const store = createStore(state.env);
    await store.register("saved", bytes(1), { version: 1 });
    const { db, path: databasePath } = openOpenClawStateDatabase({ env: state.env });
    db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`);
    for (const operation of ["lookup", "entries"] as const) {
      await expect(
        operation === "lookup" ? store.lookup("saved") : store.entries(),
      ).rejects.toMatchObject({
        code: "PLUGIN_BLOB_OPEN_FAILED",
        operation,
        path: databasePath,
      });
    }
  });
});
