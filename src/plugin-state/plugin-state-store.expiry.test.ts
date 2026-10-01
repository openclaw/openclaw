import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  getPluginStateCapacity,
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
  resetPluginStateStoreForTests,
} from "./plugin-state-store.js";
import { deleteExpiredPluginStateEntries } from "./plugin-state-store.kernel.js";
import {
  clearPluginStateStoreForTests,
  seedPluginStateEntriesForTests,
} from "./plugin-state-store.test-helpers.js";
import { sweepExpiredPluginStateEntriesInWorker } from "./plugin-state-worker-client.js";

let testState: OpenClawTestState | undefined;

beforeAll(async () => {
  testState = await createOpenClawTestState({ label: "plugin-state-expiry" });
});

beforeEach(() => {
  testState?.applyEnv();
  clearPluginStateStoreForTests();
});

afterEach(() => {
  vi.useRealTimers();
  resetPluginStateStoreForTests({ closeDatabase: false });
});

afterAll(async () => {
  resetPluginStateStoreForTests();
  await testState?.cleanup();
});

function expiredRows(namespace: string, count: number) {
  const expiresAt = Date.now() - 100;
  return Array.from({ length: count }, (_, index) => ({
    pluginId: "discord",
    namespace,
    key: `expired-${String(index).padStart(4, "0")}`,
    value: { index },
    createdAt: index,
    expiresAt,
  }));
}

describe("plugin state expiry cleanup", () => {
  it("registerIfAbsent replaces an expired target beyond the namespace cleanup batch", async () => {
    const namespace = "claims-batched-expiry";
    seedPluginStateEntriesForTests([
      ...expiredRows(namespace, 1_025),
      {
        pluginId: "discord",
        namespace,
        key: "zz-target",
        value: { version: 1 },
        createdAt: 5_000,
        expiresAt: Date.now() - 100,
      },
    ]);
    const store = createPluginStateKeyedStore<{ version: number }>("discord", {
      namespace,
      maxEntries: 10,
    });
    await expect(store.registerIfAbsent("zz-target", { version: 2 })).resolves.toBe(true);
    await expect(store.lookup("zz-target")).resolves.toEqual({ version: 2 });
    expect(await sweepExpiredPluginStateEntriesInWorker()).toBe(1);
  });

  it("sweeps expired plugin state in bounded batches without touching live rows", async () => {
    const namespace = "batched-expiry";
    seedPluginStateEntriesForTests([
      ...expiredRows(namespace, 2_050).map((row, index) => {
        row.pluginId = index % 2 === 0 ? "discord" : "telegram";
        return row;
      }),
      { pluginId: "discord", namespace, key: "permanent", value: { durable: true } },
      {
        pluginId: "discord",
        namespace,
        key: "live",
        value: { live: true },
        expiresAt: Date.now() + 86_400_000,
      },
      { pluginId: "sibling-plugin", namespace, key: "permanent", value: { sibling: true } },
    ]);
    expect(await sweepExpiredPluginStateEntriesInWorker()).toBe(1_024);
    expect(await sweepExpiredPluginStateEntriesInWorker()).toBe(1_024);
    expect(await sweepExpiredPluginStateEntriesInWorker()).toBe(2);
    expect(await sweepExpiredPluginStateEntriesInWorker()).toBe(0);
    const store = createPluginStateSyncKeyedStore("discord", { namespace, maxEntries: 10 });
    const sibling = createPluginStateSyncKeyedStore("sibling-plugin", {
      namespace,
      maxEntries: 10,
    });
    expect(store.lookup("permanent")).toEqual({ durable: true });
    expect(store.lookup("live")).toEqual({ live: true });
    expect(sibling.lookup("permanent")).toEqual({ sibling: true });
  });

  it("bounds expired namespace cleanup during update without touching sibling rows", async () => {
    const namespace = "namespace-batched-expiry";
    seedPluginStateEntriesForTests([
      ...expiredRows(namespace, 1_031),
      { pluginId: "discord", namespace, key: "permanent", value: { durable: true } },
      {
        pluginId: "discord",
        namespace: "sibling-namespace",
        key: "expired",
        value: { sibling: true },
        expiresAt: Date.now() - 100,
      },
      {
        pluginId: "sibling-plugin",
        namespace,
        key: "expired",
        value: { sibling: true },
        expiresAt: Date.now() - 100,
      },
    ]);
    const store = createPluginStateSyncKeyedStore<{ durable?: boolean; fresh?: boolean }>(
      "discord",
      { namespace, maxEntries: 10 },
    );
    expect(store.update("fresh", () => ({ fresh: true }))).toBe(true);
    expect(store.lookup("fresh")).toEqual({ fresh: true });
    expect(store.lookup("permanent")).toEqual({ durable: true });
    expect(await sweepExpiredPluginStateEntriesInWorker()).toBe(9);
  });

  it("rolls back bounded expiry cleanup when the enclosing namespace write fails", async () => {
    const namespace = "rollback-expiry";
    seedPluginStateEntriesForTests([
      ...expiredRows(namespace, 1_031),
      { pluginId: "discord", namespace, key: "first", value: { durable: 1 } },
      { pluginId: "discord", namespace, key: "second", value: { durable: 2 } },
    ]);
    const store = createPluginStateKeyedStore("discord", {
      namespace,
      maxEntries: 2,
      overflowPolicy: "reject-new",
    });
    await expect(store.register("fresh", { fresh: true })).rejects.toMatchObject({
      code: "PLUGIN_STATE_LIMIT_EXCEEDED",
    });
    expect(await sweepExpiredPluginStateEntriesInWorker()).toBe(1_024);
    expect(await sweepExpiredPluginStateEntriesInWorker()).toBe(7);
    await expect(store.lookup("fresh")).resolves.toBeUndefined();
    expect(getPluginStateCapacity("discord").liveEntries).toBe(2);
  });

  it("rechecks expiry time and newly written rows after an empty namespace cleanup", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const sweep = () =>
      runOpenClawStateWriteTransaction(({ db }) => deleteExpiredPluginStateEntries(db, Date.now()));
    const scope = { pluginId: "discord", namespace: "fresh-expiry" };
    const store = createPluginStateSyncKeyedStore(scope.pluginId, {
      namespace: scope.namespace,
      maxEntries: 10,
    });
    seedPluginStateEntriesForTests([{ ...scope, key: "future", value: 1, expiresAt: 1_200 }]);
    store.register("permanent", 2);
    expect(sweep()).toBe(0);

    vi.setSystemTime(1_200);
    store.register("permanent", 3);
    expect(sweep()).toBe(0);
    expect(store.lookup("future")).toBeUndefined();

    seedPluginStateEntriesForTests([
      { ...scope, key: "new-expired", value: 4, expiresAt: 1_100 },
      { ...scope, namespace: "sibling", key: "expired", value: 5, expiresAt: 1_100 },
    ]);
    store.register("permanent", 6);
    expect(sweep()).toBe(1);
    expect(store.entries()).toEqual([{ key: "permanent", value: 6, createdAt: 1_200 }]);
  });
});
