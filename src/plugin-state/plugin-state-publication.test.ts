import { afterEach, describe, expect, it, vi } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import type { SqliteCommittedFact } from "../infra/sqlite-commit-receipt.js";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import {
  settleSqliteWorkerOperationContext,
  type SqliteWorkerOperationContext,
} from "../infra/sqlite-worker-operation-settlement.js";
import { getWorkerMessageMetrics } from "../infra/worker-message-metrics.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { createNodeEvalArgs } from "../test-utils/node-process.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { observePluginStateReads } from "./plugin-state-fixtures.test-support.js";
import {
  capturePluginStateReadDependencies,
  pluginStatePublication,
} from "./plugin-state-publication.js";
import {
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
  importPluginStateEntriesForDoctor,
  resetPluginStateStoreForTests,
} from "./plugin-state-store.js";
import type { PluginStateRow } from "./plugin-state-store.kernel.js";
import {
  clearPluginStateStoreForTests,
  seedPluginStateEntriesForTests,
} from "./plugin-state-store.test-helpers.js";
import { executePluginStateCommand } from "./plugin-state.worker.js";

type PluginStateChange = Parameters<Parameters<typeof pluginStatePublication.subscribeFacts>[0]>[0];

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
});

function observe() {
  const changes: PluginStateChange[] = [];
  const current = new Map<string, SqliteCommittedFact<PluginStateRow>>();
  const unsubscribe = pluginStatePublication.subscribeFacts((change) => {
    if (change.kind === "pending" || change.kind === "settled") {
      return;
    }
    changes.push(change);
    if (change.kind === "committed") {
      for (const [key, fact] of change.receipt.facts) {
        current.set(key, fact);
      }
    }
  });
  const fact = (key: string, namespace = "receipts") =>
    current.get(JSON.stringify(["receipt-test", namespace, key]));
  return { changes, current, fact, unsubscribe };
}

describe("plugin state committed facts", () => {
  it("shares committed facts and invalidation across SQLite text-key aliases", async () => {
    await withOpenClawTestState({ label: "plugin-state-key-aliases" }, async ({ env }) => {
      const store = createPluginStateKeyedStore<number>("receipt-test", {
        namespace: "aliases",
        maxEntries: 10,
        env,
      });
      for (const rawKey of ["high-\ud800", "low-\udc00"]) {
        const normalizedKey = rawKey.startsWith("high") ? "high-\ufffd" : "low-\ufffd";
        await store.register(rawKey, 1);
        const raw = await capturePluginStateReadDependencies(() => store.observe(rawKey));
        const normalized = await capturePluginStateReadDependencies(() =>
          store.observe(normalizedKey),
        );
        const unrelated = await capturePluginStateReadDependencies(() => store.observe("other"));
        const read = async (expected: number | undefined) => {
          for (const key of [rawKey, normalizedKey]) {
            expect(await store.lookup(key)).toBe(expected);
            expect((await store.observe(key)).value).toBe(expected);
          }
          expect(await store.lookupMany([rawKey, normalizedKey])).toEqual([
            { ok: true, value: expected },
            { ok: true, value: expected },
          ]);
        };
        try {
          expect(raw.value.value).toBe(1);
          expect(normalized.value.value).toBe(1);
          await store.register(rawKey, 2);
          await read(2);
          expect(raw.isCurrent()).toBe(false);
          expect(normalized.isCurrent()).toBe(false);
          expect(unrelated.isCurrent()).toBe(true);
          await store.delete(normalizedKey);
          await read(undefined);
          expect(await store.entries()).toEqual([]);
          await store.register(normalizedKey, 3);
          await read(3);
          const observation = await store.observe(rawKey);
          const alias = await store.observe(normalizedKey);
          expect(alias.comparison).not.toBe(observation.comparison);
          expect(
            await store.compareAndApply(rawKey, observation.comparison, {
              operation: "update",
              action: "keep",
            }),
          ).toEqual({ status: "unchanged" });
          await store.delete(rawKey);
          await read(undefined);
        } finally {
          raw.release();
          normalized.release();
          unrelated.release();
        }
        expect(raw.isCurrent()).toBe(false);
      }
    });
  });
  it("updates resident namespaces from class-attributed worker receipts", async () => {
    await withOpenClawTestState(
      { label: "plugin-state-namespace-read-receipts" },
      async ({ env }) => {
        const options = { namespace: "receipts", maxEntries: 10, env };
        const store = createPluginStateKeyedStore<{ count: number }>("receipt-test", options);
        const native = createPluginStateSyncKeyedStore<{ count: number }>("receipt-test", options);
        const sibling = createPluginStateSyncKeyedStore("receipt-test", {
          ...options,
          namespace: "sibling",
        });
        const authorityBytes = () =>
          getWorkerMessageMetrics().find(
            (metric) => metric.kind === "authority" && metric.direction === "from_worker",
          )?.payloadBytesByRequestClass?.plugin_state ?? 0;
        const before = authorityBytes();
        await store.register("first", { count: 1 });
        expect(authorityBytes()).toBeGreaterThan(before);
        const dispatch = observePluginStateReads();
        const read = async (key: string, expected: { count: number } | undefined) => {
          const value = await store.lookup(key);
          expect(value).toEqual(expected);
          expect(await store.lookupMany([key, key])).toEqual([
            { ok: true, value: expected },
            { ok: true, value: expected },
          ]);
          expect(dispatch).not.toHaveBeenCalled();
          return value;
        };
        const initial = await store.entries();
        expect(initial).toMatchObject([{ key: "first", value: { count: 1 } }]);
        expect(dispatch).toHaveBeenCalledOnce();
        initial[0]!.value.count = 99;
        dispatch.mockClear();
        const first = await read("first", { count: 1 });
        first!.count = 99;
        sibling.register("other", true);
        expect(await store.entries()).toMatchObject([{ key: "first", value: { count: 1 } }]);
        expect(dispatch).not.toHaveBeenCalled();

        await read("first", { count: 1 });

        const asyncSibling = createPluginStateKeyedStore("receipt-test", {
          ...options,
          namespace: "sibling",
        });
        const pendingReads: Array<ReturnType<typeof store.entries>> = [];
        const stopPending = pluginStatePublication.subscribeFacts((change) => {
          if (change.kind === "pending" && pendingReads.length === 0) {
            pendingReads.push(store.entries());
          }
        });
        try {
          await asyncSibling.register("other", false);
          expect(pendingReads).toHaveLength(1);
          expect(await pendingReads.shift()).toMatchObject([{ key: "first", value: { count: 1 } }]);
          expect(dispatch).not.toHaveBeenCalled();
          dispatch.mockClear();
          await store.register("first", { count: 2 });
          expect(pendingReads).toHaveLength(1);
          expect(await pendingReads.shift()).toMatchObject([{ key: "first", value: { count: 2 } }]);
          expect(dispatch).not.toHaveBeenCalled();
          dispatch.mockClear();
        } finally {
          stopPending();
        }

        await read("first", { count: 2 });
        native.register("second", { count: 2 });
        await read("second", { count: 2 });
        expect(await store.entries()).toMatchObject([
          { key: "first", value: { count: 2 } },
          { key: "second", value: { count: 2 } },
        ]);
        expect(dispatch).not.toHaveBeenCalled();
        await store.delete("first");
        await read("first", undefined);
        expect(await store.entries()).toMatchObject([{ key: "second", value: { count: 2 } }]);
        native.clear();
        await read("second", undefined);
        expect(await store.entries()).toEqual([]);
        dispatch.mockClear();
        expect(await store.entries()).toEqual([]);
        expect(dispatch).not.toHaveBeenCalled();
        await store.register("renewed", { count: 3 });
        await read("renewed", { count: 3 });
        expect(await store.entries()).toMatchObject([{ key: "renewed", value: { count: 3 } }]);
        await store.clear();
        await read("renewed", undefined);
      },
    );
  });

  it("expires cached namespace rows and reloads after an uncertain publication", async () => {
    await withOpenClawTestState({ label: "plugin-state-namespace-expiry" }, async ({ env }) => {
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const options = { namespace: "receipts", maxEntries: 10, env };
      const native = createPluginStateSyncKeyedStore("receipt-test", options);
      const store = createPluginStateKeyedStore("receipt-test", options);
      native.register("expiring", true, { ttlMs: 10_000 });
      native.register("permanent", true);
      expect((await store.entries()).map((entry) => entry.key)).toEqual(["expiring", "permanent"]);
      const dispatch = observePluginStateReads();
      now += 10_000;
      expect((await store.entries()).map((entry) => entry.key)).toEqual(["permanent"]);
      expect(dispatch).not.toHaveBeenCalled();
      now -= 10_000;
      expect((await store.entries()).map((entry) => entry.key)).toEqual(["expiring", "permanent"]);
      expect(dispatch).not.toHaveBeenCalled();
      const stopFault = pluginStatePublication.subscribeFacts((change) => {
        if (change.kind === "committed") {
          throw new Error("fact sink unavailable");
        }
      });
      try {
        native.clear();
      } finally {
        stopFault();
      }
      expect(await store.entries()).toEqual([]);
      expect(dispatch).toHaveBeenCalledOnce();
    });
  });

  it("discards a cold load overtaken by a committed write", async () => {
    await withOpenClawTestState({ label: "plugin-state-load-overlap" }, async ({ env }) => {
      const options = { namespace: "receipts", maxEntries: 10, env };
      const store = createPluginStateKeyedStore("receipt-test", options);
      const native = createPluginStateSyncKeyedStore("receipt-test", options);
      native.register("key", "before");
      let changed = false;
      const dispatch = observePluginStateReads(() => {
        if (!changed) {
          changed = true;
          native.register("key", "after");
        }
      });
      expect(await store.entries()).toMatchObject([{ key: "key", value: "after" }]);
      expect(changed).toBe(true);
      expect(await store.lookup("key")).toBe("after");
      dispatch.mockClear();
      expect(await store.lookup("key")).toBe("after");
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  it("reloads evicted namespaces and never rejects a write to satisfy residency bounds", async () => {
    await withOpenClawTestState({ label: "plugin-state-resident-bounds" }, async ({ env }) => {
      const stores = Array.from({ length: 65 }, (_, index) =>
        createPluginStateKeyedStore("receipt-test", {
          namespace: `scope-${index}`,
          maxEntries: 10,
          env,
        }),
      );
      await stores[0]!.register("key", "durable");
      for (const store of stores) {
        await store.entries();
      }
      const dispatch = observePluginStateReads();
      expect(await stores[1]!.lookup("key")).toBeUndefined();
      expect(dispatch).not.toHaveBeenCalled();
      expect(await stores[0]!.lookup("key")).toBe("durable");
      expect(dispatch).toHaveBeenCalledOnce();
      const large = createPluginStateKeyedStore<string>("receipt-test", {
        namespace: "large",
        maxEntries: 10,
        env,
      });
      const value = "x".repeat(1_000_000);
      seedPluginStateEntriesForTests(
        Array.from({ length: 4 }, (_, index) => ({
          pluginId: "receipt-test",
          namespace: "large",
          key: String(index),
          value,
        })),
      );
      expect(await large.count()).toBe(4);
      dispatch.mockClear();
      await large.register("4", value);
      expect(await large.count()).toBe(5);
      expect(dispatch).toHaveBeenCalledTimes(2);
      dispatch.mockClear();
      expect(await large.count()).toBe(5);
      expect(dispatch).toHaveBeenCalledOnce();
      await large.delete("4");
      dispatch.mockClear();
      expect(await large.count()).toBe(4);
      expect(dispatch).toHaveBeenCalledOnce();
      dispatch.mockClear();
      expect(await large.count()).toBe(4);
      expect(dispatch).not.toHaveBeenCalled();

      await large.delete("3");
      for (const [index, rows] of [3, 2].entries()) {
        const other = createPluginStateKeyedStore<string>("receipt-test", {
          namespace: `byte-bound-${index}`,
          maxEntries: 10,
          env,
        });
        seedPluginStateEntriesForTests(
          Array.from({ length: rows }, (_, row) => ({
            pluginId: "receipt-test",
            namespace: `byte-bound-${index}`,
            key: String(row),
            value,
          })),
        );
        await other.count();
      }
      // Growing one resident map can evict a later map during the same fact batch.
      await large.register("growth", "x".repeat(500_000));
      dispatch.mockClear();
      expect(await large.count()).toBe(4);
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  it("rebuilds from durable state after a writer exits between commit and acknowledgement", async () => {
    await withOpenClawTestState({ label: "plugin-state-crash-reload" }, async ({ env }) => {
      const options = { namespace: "receipts", maxEntries: 10, env };
      const store = createPluginStateKeyedStore("receipt-test", options);
      await store.register("key", "before");
      await store.entries();
      await closeOpenClawStateDatabaseAsync();
      const result = await runNodeScript(
        createNodeEvalArgs(
          `
        import { createPluginStateSyncKeyedStore } from ${JSON.stringify(new URL("./plugin-state-store.ts", import.meta.url).href)};
        import { pluginStatePublication } from ${JSON.stringify(new URL("./plugin-state-publication.ts", import.meta.url).href)};
        pluginStatePublication.subscribeFacts((change) => { if (change.kind === "committed") process.exit(76); });
        createPluginStateSyncKeyedStore("receipt-test", { namespace: "receipts", maxEntries: 10 }).register("key", "committed");
        process.exit(77);
      `,
          { imports: [import.meta.resolve("tsx/esm")] },
        ),
        env,
        30_000,
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(76);
      const reads = observePluginStateReads();
      expect(await store.lookup("key")).toBe("committed");
      expect(reads).toHaveBeenCalledOnce();
      reads.mockClear();
      expect(await store.lookup("key")).toBe("committed");
      expect(reads).not.toHaveBeenCalled();
    });
  });

  it("publishes fixture cleanup to warm observations and ownership reads", async () => {
    await withOpenClawTestState({ label: "plugin-state-clear-publication" }, async ({ env }) => {
      const store = createPluginStateKeyedStore("receipt-test", {
        namespace: "bindings",
        maxEntries: 10,
        env,
      });
      await store.register("session", { model: "first" });
      const captured = await capturePluginStateReadDependencies(() => store.observe("session"));
      const reads = observePluginStateReads();
      try {
        clearPluginStateStoreForTests();
        expect(captured.isCurrent()).toBe(false);
        expect((await store.observe("session")).value).toBeUndefined();
        expect(reads).not.toHaveBeenCalled();
      } finally {
        captured.release();
      }
    });
  });

  it("keeps cached reads coherent after conditional writes and capacity rollback", async () => {
    await withOpenClawTestState({ label: "plugin-state-conditional-receipts" }, async ({ env }) => {
      const options = {
        namespace: "receipts",
        maxEntries: 1,
        overflowPolicy: "reject-new" as const,
        env,
      };
      const worker = createPluginStateKeyedStore<number>("receipt-test", options);
      const native = createPluginStateSyncKeyedStore<number>("receipt-test", options);
      const read = async (expected: number | undefined) => {
        expect(await worker.lookup("key")).toBe(expected);
        expect((await worker.observe("key")).value).toBe(expected);
        expect(await worker.lookup("overflow")).toBeUndefined();
        expect((await worker.observe("overflow")).value).toBeUndefined();
        expect((await worker.entries()).map(({ key, value }) => ({ key, value }))).toEqual(
          expected === undefined ? [] : [{ key: "key", value: expected }],
        );
      };

      await read(undefined);
      expect(await worker.registerIfAbsent("key", 1)).toBe(true);
      await read(1);
      expect(native.registerIfAbsent("key", 2)).toBe(false);
      expect(await worker.registerIfAbsent("key", 3)).toBe(false);
      await read(1);
      expect(() => native.registerIfAbsent("overflow", 4)).toThrow("1-row limit");
      await read(1);
      await expect(worker.registerIfAbsent("overflow", 5)).rejects.toMatchObject({
        code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      });
      await read(1);

      expect(native.delete("key")).toBe(true);
      await read(undefined);
      expect(native.registerIfAbsent("key", 6)).toBe(true);
      await read(6);
      clearPluginStateStoreForTests();
      await read(undefined);
    });
  });

  it.each(["lookup", "observe"] as const)(
    "keeps a prepared %s current only until its exact dependency commits",
    async (method) => {
      await withOpenClawTestState({ label: "plugin-state-read-dependencies" }, async ({ env }) => {
        const options = { namespace: "bindings", maxEntries: 10, env };
        const worker = createPluginStateKeyedStore("receipt-test", options);
        const native = createPluginStateSyncKeyedStore("receipt-test", options);
        const unrelated = createPluginStateSyncKeyedStore("receipt-test", {
          namespace: "unrelated",
          maxEntries: 10,
          env,
        });
        await worker.register("session", { model: "first" });
        const read = () =>
          method === "observe"
            ? worker.observe("session").then(({ value }) => value)
            : worker.lookup("session");
        const captured = await capturePluginStateReadDependencies(read);
        try {
          expect(captured.value).toEqual({ model: "first" });
          unrelated.register("session", { model: "unrelated" });
          native.register("another-session", { model: "another" });
          expect(captured.isCurrent()).toBe(true);

          native.register("session", { model: "replacement" });
          expect(captured.isCurrent()).toBe(false);
          expect(() => captured.assertCurrent()).toThrow("Plugin state changed");
        } finally {
          captured.release();
        }
        const replacement = await capturePluginStateReadDependencies(read);
        expect(replacement.value).toEqual({ model: "replacement" });
        expect(replacement.isCurrent()).toBe(true);
        replacement.release();
        expect(() => replacement.assertCurrent()).toThrow("Plugin state changed");
      });
    },
  );

  it("invalidates a captured legacy absence when its database is first created", async () => {
    await withOpenClawTestState(
      { label: "plugin-state-missing-read-dependency" },
      async ({ env }) => {
        const native = createPluginStateSyncKeyedStore("receipt-test", {
          namespace: "bindings",
          maxEntries: 10,
          env,
        });
        const captured = await capturePluginStateReadDependencies(async () =>
          native.lookup("session"),
        );
        try {
          expect(captured.value).toBeUndefined();
          expect(captured.isCurrent()).toBe(true);
          native.register("session", { model: "created" });
          expect(captured.isCurrent()).toBe(false);
        } finally {
          captured.release();
        }
      },
    );
  });

  it("delivers empty deletion receipts at settlement and changed deletions immediately", async () => {
    await withOpenClawTestState({ label: "plugin-state-delete-receipts" }, async ({ env }) => {
      const database = openOpenClawStateDatabase({ env });
      for (const changed of [false, true]) {
        if (changed) {
          seedPluginStateEntriesForTests([
            {
              pluginId: "receipt-test",
              namespace: "receipts",
              key: "expired",
              value: true,
              expiresAt: 1,
            },
          ]);
        }
        const transport = admission.createSqliteWorkerOperationAdmission((_request, grant) =>
          grant(),
        );
        const owner: SqliteWorkerOperationContext = { port: transport.port };
        const published = vi.fn();
        admission.observeSqliteWorkerCommittedFacts(transport, published);
        const postMessage = transport.port.postMessage.bind(transport.port);
        const sent = vi
          .spyOn(transport.port, "postMessage")
          .mockImplementation((message, transfers) => {
            postMessage(message, transfers);
            // Service real admission requests synchronously; receipt frames remain queued for inspection.
            if (message.decision) {
              transport.service();
            }
          });
        try {
          const result = admission.withSqliteWorkerOperationAdmission(owner, () =>
            executePluginStateCommand(
              {
                type: "pluginState.delete",
                input: { pluginId: "receipt-test", namespace: "receipts", key: "expired" },
              },
              { path: database.path, env },
              () => database,
              true,
            ),
          );
          expect(result).toEqual({ ok: true, value: changed });
          expect(
            database.db.prepare("SELECT count(*) AS count FROM plugin_state_entries").get(),
          ).toEqual({ count: 0 });
          expect(owner.committed?.facts).toMatchObject({
            domain: "plugin-state",
            facts: expect.any(Map),
          });
          expect(
            sent.mock.calls.filter(([message]) => message.kind === "native-commit"),
          ).toHaveLength(Number(changed));
          transport.service();
          expect(published).toHaveBeenCalledTimes(Number(changed));
          if (!changed) {
            expect(transport.committed).toBeUndefined();
          }
          settleSqliteWorkerOperationContext(owner, "completed");
          expect(transport.waitForSettlement(performance.now())).toMatchObject({
            kind: "completed",
            committed: { facts: { domain: "plugin-state", facts: expect.any(Map) } },
          });
          expect(published).toHaveBeenCalledOnce();
          expect(published.mock.calls[0]?.[0].facts.facts.size).toBe(Number(changed));
        } finally {
          sent.mockRestore();
          transport.finish();
        }
      }
    });
  });

  it("installs native transaction facts after commit and discards savepoint rollback", async () => {
    await withOpenClawTestState({ label: "plugin-state-native-receipt" }, async ({ env }) => {
      const store = createPluginStateSyncKeyedStore("receipt-test", {
        namespace: "receipts",
        maxEntries: 10,
        env,
      });
      const seen = observe();
      try {
        runOpenClawStateWriteTransaction(
          () => {
            store.register("a", "first");
            expect(() =>
              runOpenClawStateWriteTransaction(
                () => {
                  store.register("a", "rolled back");
                  store.register("discard", true);
                  throw new Error("rollback nested");
                },
                { env },
              ),
            ).toThrow("rollback nested");
            store.register("b", "second");
            expect(seen.changes).toEqual([]);
          },
          { env },
        );
        expect(seen.fact("a")).toMatchObject({
          kind: "postimage",
          value: { value_json: '"first"' },
        });
        expect(seen.fact("b")).toMatchObject({
          kind: "postimage",
          value: { value_json: '"second"' },
        });
        expect(seen.fact("discard")).toBeUndefined();
        const count = seen.changes.length;
        expect(() =>
          runOpenClawStateWriteTransaction(
            () => {
              store.clear();
              throw new Error("rollback outer");
            },
            { env },
          ),
        ).toThrow("rollback outer");
        expect(seen.changes).toHaveLength(count);
        expect(store.lookup("a")).toBe("first");

        let mutationFailure: unknown;
        const stopMutation = pluginStatePublication.subscribeFacts((change) => {
          if (change.kind !== "committed") {
            return;
          }
          const fact = change.receipt.facts.get(
            JSON.stringify(["receipt-test", "receipts", "reentrant"]),
          );
          if (fact?.kind === "postimage") {
            try {
              store.delete("reentrant");
            } catch (error) {
              mutationFailure = error;
            }
          }
        });
        const later = observe();
        try {
          store.register("reentrant", "committed");
          expect(store.lookup("reentrant")).toBe("committed");
          expect(mutationFailure).toMatchObject({
            code: "PLUGIN_STATE_WRITE_FAILED",
            cause: { message: "Plugin state cannot mutate during fact installation" },
          });
          expect(later.fact("reentrant")).toMatchObject({
            kind: "postimage",
            value: { value_json: '"committed"' },
          });
        } finally {
          later.unsubscribe();
          stopMutation();
        }
      } finally {
        seen.unsubscribe();
      }
    });
  });

  it("publishes exact expiry, eviction, atomic consume and namespace-clear tombstones", async () => {
    await withOpenClawTestState({ label: "plugin-state-tombstones" }, async ({ env }) => {
      let now = 100;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const options = { namespace: "receipts", maxEntries: 2, env };
      const store = createPluginStateSyncKeyedStore("receipt-test", options);
      const sibling = createPluginStateSyncKeyedStore("receipt-test", {
        ...options,
        namespace: "sibling",
      });
      const seen = observe();
      try {
        sibling.register("keep", true);
        store.register("old", 1);
        const reader = createPluginStateKeyedStore("receipt-test", options);
        await reader.entries();
        const reads = observePluginStateReads();
        now++;
        store.register("expiring", 2, { ttlMs: 1 });
        now++;
        store.register("new", 3);
        expect(seen.fact("expiring")).toEqual({ kind: "absent" });
        expect(await reader.lookup("expiring")).toBeUndefined();
        now++;
        store.register("newest", 4);
        expect(seen.fact("old")).toEqual({ kind: "absent" });
        expect(await reader.lookup("old")).toBeUndefined();
        expect(store.registerIfAbsent("newest", 5)).toBe(false);
        expect(seen.fact("newest")).toMatchObject({
          kind: "postimage",
          value: { value_json: "4" },
        });
        expect(store.consume("new")).toBe(3);
        expect(store.consume("new")).toBeUndefined();
        expect(seen.fact("new")).toEqual({ kind: "absent" });
        expect(await reader.lookup("new")).toBeUndefined();
        expect(store.update("newest", () => 6)).toBe(true);
        expect(seen.fact("newest")).toMatchObject({
          kind: "postimage",
          value: { value_json: "6" },
        });
        expect(await reader.lookup("newest")).toBe(6);
        expect(store.deleteIf("newest", (value) => value === 6)).toBe(true);
        expect(seen.fact("newest")).toEqual({ kind: "absent" });
        expect(await reader.lookup("newest")).toBeUndefined();
        expect(store.registerIfAbsent("again", true)).toBe(true);
        store.register("unicode-\ud800", true);
        expect(seen.fact("unicode-\ufffd")).toMatchObject({ kind: "postimage" });
        store.clear();
        expect(seen.fact("again")).toEqual({ kind: "absent" });
        expect(seen.fact("unicode-\ufffd")).toEqual({ kind: "absent" });
        expect(seen.fact("keep", "sibling")).toMatchObject({ kind: "postimage" });
        expect(sibling.lookup("keep")).toBe(true);
        expect(await reader.entries()).toEqual([]);
        expect(reads).not.toHaveBeenCalled();
      } finally {
        seen.unsubscribe();
      }
    });
  });

  it("keeps successful Doctor import prefixes and invalidates failed fact installation", async () => {
    await withOpenClawTestState({ label: "plugin-state-import-facts" }, async ({ env }) => {
      const options = { namespace: "receipts", maxEntries: 2, env };
      const seen = observe();
      const reader = createPluginStateKeyedStore("receipt-test", options);
      await reader.register("seed", true);
      await reader.clear();
      await reader.entries();
      const reads = observePluginStateReads();
      try {
        expect(() =>
          importPluginStateEntriesForDoctor("receipt-test", options, [
            { key: "first", value: true, createdAt: 1 },
            { key: "bad", value: true, createdAt: Number.NaN },
          ]),
        ).toThrow();
        expect(seen.fact("first")).toMatchObject({ kind: "postimage" });
        expect(seen.fact("bad")).toBeUndefined();
        expect(await reader.lookup("first")).toBe(true);
        expect(await reader.lookup("bad")).toBeUndefined();
        expect(reads).not.toHaveBeenCalled();
        const beforeFailure = seen.changes.length;
        const stopFault = pluginStatePublication.subscribeFacts((change) => {
          if (change.kind === "committed") {
            throw new Error("fact sink unavailable");
          }
        });
        try {
          const store = createPluginStateSyncKeyedStore("receipt-test", options);
          expect(() => store.delete("first")).not.toThrow();
          expect(store.lookup("first")).toBeUndefined();
          expect(seen.changes.slice(beforeFailure)).toContainEqual(
            expect.objectContaining({ kind: "unknown" }),
          );
        } finally {
          stopFault();
        }
      } finally {
        seen.unsubscribe();
      }
    });
  });

  it("installs whole worker receipts before atomic operation replies and write-time expiry", async () => {
    await withOpenClawTestState({ label: "plugin-state-worker-facts" }, async ({ env }) => {
      const store = createPluginStateKeyedStore("receipt-test", {
        namespace: "receipts",
        maxEntries: 2,
        env,
      });
      const seen = observe();
      try {
        expect(
          await Promise.all([
            store.registerIfAbsent("claim", 1),
            store.registerIfAbsent("claim", 2),
          ]),
        ).toEqual([true, false]);
        expect(seen.fact("claim")).toMatchObject({ kind: "postimage", value: { value_json: "1" } });
        expect(await Promise.all([store.consume("claim"), store.consume("claim")])).toEqual([
          1,
          undefined,
        ]);
        expect(seen.fact("claim")).toEqual({ kind: "absent" });
        seedPluginStateEntriesForTests([
          {
            pluginId: "receipt-test",
            namespace: "receipts",
            key: "expired",
            value: true,
            expiresAt: 1,
          },
        ]);
        await store.register("a", true);
        expect(seen.fact("expired")).toEqual({ kind: "absent" });
        await store.register("b", true);
        await store.clear();
        const clear = seen.changes.findLast((change) => change.kind === "committed");
        expect(clear?.receipt.facts.size).toBe(2);
        expect([...clear!.receipt.facts.values()]).toEqual([
          { kind: "absent" },
          { kind: "absent" },
        ]);
      } finally {
        seen.unsubscribe();
      }
    });
  });

  it("preserves native deletions before delayed worker receipt installation", async () => {
    await withOpenClawTestState({ label: "plugin-state-receipt-supersession" }, async ({ env }) => {
      const options = { namespace: "receipts", maxEntries: 2, env };
      const native = createPluginStateSyncKeyedStore("receipt-test", options);
      const worker = createPluginStateKeyedStore("receipt-test", options);
      native.register("key", "before");
      await worker.entries();
      const reads = observePluginStateReads();
      const seen = observe();
      const original = admission.observeSqliteWorkerCommittedFacts;
      vi.spyOn(admission, "observeSqliteWorkerCommittedFacts").mockImplementation(
        (owner, listener) => {
          original(owner, (receipt) => {
            native.delete("key");
            listener(receipt);
          });
        },
      );
      try {
        await worker.register("key", "late");
        expect(native.lookup("key")).toBeUndefined();
        expect(await worker.entries()).toEqual([]);
        expect(reads).toHaveBeenCalledOnce();
        reads.mockClear();
        expect(await worker.lookup("key")).toBeUndefined();
        expect(reads).not.toHaveBeenCalled();
        expect(seen.fact("key")).toEqual({ kind: "unknown" });
        const committed = seen.changes.filter((change) => change.kind === "committed");
        expect(committed).toHaveLength(2);
        expect([...committed[0]!.receipt.facts.values()]).toEqual([{ kind: "absent" }]);
      } finally {
        seen.unsubscribe();
      }
    });
  });
});
