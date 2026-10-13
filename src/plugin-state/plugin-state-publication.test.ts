import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqliteCommittedFact } from "../infra/sqlite-commit-receipt.js";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import {
  settleSqliteWorkerOperationContext,
  type SqliteWorkerOperationContext,
} from "../infra/sqlite-worker-operation-settlement.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { pluginStatePublication } from "./plugin-state-publication.js";
import {
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
  importPluginStateEntriesForDoctor,
  resetPluginStateStoreForTests,
} from "./plugin-state-store.js";
import type { PluginStateRow } from "./plugin-state-store.kernel.js";
import { seedPluginStateEntriesForTests } from "./plugin-state-store.test-helpers.js";
import { sweepExpiredPluginStateEntriesInWorker } from "./plugin-state-worker-client.js";
import { executePluginStateCommand } from "./plugin-state.worker.js";

type PluginStateChange = Parameters<Parameters<typeof pluginStatePublication.subscribe>[0]>[0];

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
});

function observe() {
  const changes: PluginStateChange[] = [];
  const current = new Map<string, SqliteCommittedFact<PluginStateRow>>();
  const unsubscribe = pluginStatePublication.subscribeFacts((change) => {
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
  it("delivers empty sweep receipts at settlement and changed sweeps immediately", async () => {
    await withOpenClawTestState({ label: "plugin-state-empty-sweep-delivery" }, async ({ env }) => {
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
              { type: "pluginState.sweep", input: undefined },
              { path: database.path, env },
              () => database,
              true,
            ),
          );
          expect(result).toEqual({ ok: true, value: Number(changed) });
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

  it("installs every native transaction fact before observers and discards savepoint rollback", async () => {
    await withOpenClawTestState({ label: "plugin-state-native-receipt" }, async ({ env }) => {
      const store = createPluginStateSyncKeyedStore("receipt-test", {
        namespace: "receipts",
        maxEntries: 10,
        env,
      });
      const seen = observe();
      const snapshots: unknown[] = [];
      const unsubscribe = pluginStatePublication.subscribe(() =>
        snapshots.push([seen.fact("a"), seen.fact("b")]),
      );
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
        expect(snapshots).toEqual(
          Array.from({ length: 2 }, () => [seen.fact("a"), seen.fact("b")]),
        );
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
        unsubscribe();
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
        now++;
        store.register("expiring", 2, { ttlMs: 1 });
        now++;
        store.register("new", 3);
        expect(seen.fact("expiring")).toEqual({ kind: "absent" });
        now++;
        store.register("newest", 4);
        expect(seen.fact("old")).toEqual({ kind: "absent" });
        expect(store.registerIfAbsent("newest", 5)).toBe(false);
        expect(seen.fact("newest")).toMatchObject({
          kind: "postimage",
          value: { value_json: "4" },
        });
        expect(store.consume("new")).toBe(3);
        expect(store.consume("new")).toBeUndefined();
        expect(seen.fact("new")).toEqual({ kind: "absent" });
        expect(store.update("newest", () => 6)).toBe(true);
        expect(seen.fact("newest")).toMatchObject({
          kind: "postimage",
          value: { value_json: "6" },
        });
        expect(store.deleteIf("newest", (value) => value === 6)).toBe(true);
        expect(seen.fact("newest")).toEqual({ kind: "absent" });
        expect(store.registerIfAbsent("again", true)).toBe(true);
        store.register("unicode-\ud800", true);
        expect(seen.fact("unicode-\ufffd")).toMatchObject({ kind: "postimage" });
        store.clear();
        expect(seen.fact("again")).toEqual({ kind: "absent" });
        expect(seen.fact("unicode-\ufffd")).toEqual({ kind: "absent" });
        expect(seen.fact("keep", "sibling")).toMatchObject({ kind: "postimage" });
        expect(sibling.lookup("keep")).toBe(true);
      } finally {
        seen.unsubscribe();
      }
    });
  });

  it("keeps successful Doctor import prefixes and fences fact failures before notifying", async () => {
    await withOpenClawTestState({ label: "plugin-state-import-facts" }, async ({ env }) => {
      const options = { namespace: "receipts", maxEntries: 2, env };
      const seen = observe();
      try {
        expect(() =>
          importPluginStateEntriesForDoctor("receipt-test", options, [
            { key: "first", value: true, createdAt: 1 },
            { key: "bad", value: true, createdAt: Number.NaN },
          ]),
        ).toThrow();
        expect(seen.fact("first")).toMatchObject({ kind: "postimage" });
        expect(seen.fact("bad")).toBeUndefined();
        const notifications: PluginStateChange[] = [];
        const stopObserver = pluginStatePublication.subscribe((change) =>
          notifications.push(change),
        );
        const stopFault = pluginStatePublication.subscribeFacts((change) => {
          if (change.kind === "committed") {
            throw new Error("fact sink unavailable");
          }
        });
        try {
          const store = createPluginStateSyncKeyedStore("receipt-test", options);
          expect(() => store.delete("first")).not.toThrow();
          expect(store.lookup("first")).toBeUndefined();
          expect(notifications).toEqual([expect.objectContaining({ kind: "unknown" })]);
        } finally {
          stopFault();
          stopObserver();
        }
      } finally {
        seen.unsubscribe();
      }
    });
  });

  it("installs whole worker receipts before atomic operation replies, including sweep", async () => {
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
        expect(await sweepExpiredPluginStateEntriesInWorker({ env })).toBe(1);
        expect(seen.fact("expired")).toEqual({ kind: "absent" });
        await store.register("a", true);
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

  it("preserves native deletions before receipt installation and during postcommit notification", async () => {
    await withOpenClawTestState({ label: "plugin-state-receipt-supersession" }, async ({ env }) => {
      const options = { namespace: "receipts", maxEntries: 2, env };
      const native = createPluginStateSyncKeyedStore("receipt-test", options);
      const worker = createPluginStateKeyedStore("receipt-test", options);
      native.register("key", "before");
      const seen = observe();
      const original = admission.observeSqliteWorkerCommittedFacts;
      const intercept = vi
        .spyOn(admission, "observeSqliteWorkerCommittedFacts")
        .mockImplementation((owner, listener) => {
          original(owner, (receipt) => {
            native.delete("key");
            listener(receipt);
          });
        });
      try {
        await worker.register("key", "late");
        expect(native.lookup("key")).toBeUndefined();
        expect(seen.fact("key")).toEqual({ kind: "unknown" });
        const committed = seen.changes.filter((change) => change.kind === "committed");
        expect(committed).toHaveLength(2);
        expect([...committed[0]!.receipt.facts.values()]).toEqual([{ kind: "absent" }]);
        intercept.mockRestore();
        let deletedDuringNotification = false;
        const stopNotification = pluginStatePublication.subscribe((change) => {
          if (change.kind !== "committed") {
            return;
          }
          const current = change.receipt.facts.get(
            JSON.stringify(["receipt-test", "receipts", "key"]),
          );
          if (current?.kind === "postimage" && current.value.value_json === '"notification"') {
            deletedDuringNotification = native.delete("key");
          }
        });
        try {
          await worker.register("key", "notification");
          expect(deletedDuringNotification).toBe(true);
          expect(native.lookup("key")).toBeUndefined();
          expect(seen.fact("key")).toEqual({ kind: "absent" });
        } finally {
          stopNotification();
        }
      } finally {
        seen.unsubscribe();
      }
    });
  });
});
