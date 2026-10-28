import assert from "node:assert/strict";
import { linkSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { createEnteredGate } from "../agents/entered-gate.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { initializeSqliteRuntimeCapabilities } from "./bun-sqlite-library.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { admitSqliteSchema } from "./sqlite-schema-facts.js";
import {
  captureSqliteWorkerOpen,
  reclaimSqliteWorkerClient,
  reserveSqliteWorkerClient,
  selectIdleSqliteWorkerClients,
} from "./sqlite-worker-broker-admission.js";
import * as workerLifecycle from "./sqlite-worker-broker-lifecycle.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import { resolveSqliteWorkerStoreCap } from "./sqlite-worker-store-limits.js";
import { createSqliteWorkerClient } from "./sqlite-worker-client.js";
import { createSqliteWorkerClientActor } from "./sqlite-worker-client.test-support.js";
import {
  useSqliteWorkerStoreFixture,
  readWorkerRows,
  appendWorkerRow,
} from "./sqlite-worker-fixture.test-support.js";
import { SqliteWorkerInputAdmission } from "./sqlite-worker-input-admission.js";
import type { FixtureOperations } from "./sqlite-worker-store.test-support.js";
import type { StoreClient } from "./sqlite-worker-broker.types.js";

function inputAdmission() {
  return new SqliteWorkerInputAdmission({
    queuedBytes: () => 0,
    isClosing: () => false,
    maxQueuedBytes: 1024,
    maxQueuedInputBytes: 1024,
    maxMessageBytes: 1024,
    maxPendingOpens: 2,
  });
}

function capacityFixture() {
  const reservations = new Set<object>();
  const retirement = createDeferredCore();
  const actor = createSqliteWorkerClientActor();
  const { client, store } = createSqliteWorkerClient({
    actor,
    isDraining: () => false,
    isAvailable: () => true,
    dispatch: async () => undefined,
    release: async () => {
      await retirement.promise;
      reservations.delete(client);
    },
    retireIdle: (): Promise<void> => store.close(),
  });
  reservations.add(client);
  const options = captureSqliteWorkerOpen({
    moduleUrl: new URL(actor.moduleUrl),
    databasePath: actor.databasePath,
    input: undefined,
  });
  const reserve = () => reserveSqliteWorkerClient(reservations, [client], 1, {});
  const reclaim = (isClosing = () => false) =>
    reclaimSqliteWorkerClient(options, [client], reserve, isClosing);
  return { options, client, retirement, reservations, reserve, reclaim };
}

it("waits for retirement and atomically reserves the released capacity", async () => {
  const f = capacityFixture();
  const admitted = vi.fn();
  const opening = f.reclaim().then(admitted);
  expect(f.reserve()).toBe(false);
  expect(admitted).not.toHaveBeenCalled();
  f.retirement.resolve();
  await opening;
  expect(f.reservations.size).toBe(1);
  expect(f.reservations.has(f.client)).toBe(false);
  expect(f.reserve()).toBe(false);
});

it.each(["before retirement", "after retirement", "cancellation", "shutdown"] as const)(
  "refuses stale opening authority %s",
  async (when) => {
    const f = capacityFixture();
    const controller = new AbortController();
    f.options.signal = controller.signal;
    let revoked = when === "before retirement";
    f.options.assertCurrent = () => {
      if (revoked && when !== "shutdown" && when !== "cancellation") {
        throw new Error("Opening owner was revoked");
      }
    };
    const result = expect(f.reclaim(() => revoked && when === "shutdown")).rejects.toThrow(
      when === "shutdown" ? "host is closing" : "Opening owner was revoked",
    );
    revoked = true;
    if (when === "cancellation") {
      controller.abort(new Error("Opening owner was revoked"));
    }
    f.retirement.resolve();
    await result;
    expect(f.reservations.has(f.client)).toBe(when === "before retirement");
    expect(f.reservations.size).toBe(when === "before retirement" ? 1 : 0);
  },
);

it("does not reclaim an idle client from another runtime generation", async () => {
  const f = capacityFixture();
  f.options.runtimeGeneration = { resolve: (url) => url, retain() {} };
  await expect(f.reclaim()).rejects.toMatchObject({ code: "overloaded" });
  expect(f.client.sealed).toBe(false);
});

it("propagates retirement failure without admitting a replacement", async () => {
  const f = capacityFixture();
  const result = expect(f.reclaim()).rejects.toThrow("native cleanup failed");
  f.retirement.reject(new Error("native cleanup failed"));
  await result;
  expect(f.reservations.has(f.client)).toBe(true);
});

it.each(["queued", "reused"] as const)("bounds and drains pending %s opens", async (kind) => {
  const admission = inputAdmission();
  const finish = createDeferredCore();
  let finished = false;
  const open = async () => {
    await finish.promise;
    finished = true;
    return "opened";
  };
  const pending = [
    admission.open(0, open, undefined, kind === "reused" ? open : undefined),
    admission.open(0, async () => {}),
  ];
  const joined = admission.joinOpens().then(() => finished);
  try {
    await expect(admission.open(0, async () => {})).rejects.toMatchObject({ code: "overloaded" });
    if (kind === "reused") {
      await pending[1];
    }
  } finally {
    finish.resolve();
    await Promise.all(pending);
  }
  expect(await joined).toBe(true);
  await expect(admission.open(0, async () => "admitted")).resolves.toBe("admitted");
  expect(admission.retainedBytes).toBe(0);
});

it.each(["shared-state", "agent"] as const)(
  "admits cold %s beside ordinary opens within one input budget",
  async (carrierClass) => {
    const admission = inputAdmission();
    const finishOrdinary = createDeferredCore();
    const isolatedGate = createEnteredGate();
    const openIsolated = <T>(bytes: number, run: () => Promise<T>) =>
      admission.open(bytes, run, undefined, undefined, carrierClass);
    const ordinary = admission.open(512, () => finishOrdinary.promise);
    const isolated = openIsolated(512, isolatedGate.wait);
    try {
      await isolatedGate.entered;
      await expect(admission.open(1, async () => {})).rejects.toMatchObject({ code: "overloaded" });
      isolatedGate.release();
      await isolated;
      expect(admission.retainedBytes).toBe(512);
      await expect(openIsolated(513, async () => {})).rejects.toMatchObject({ code: "overloaded" });
      await expect(openIsolated(512, async () => "isolated reopened")).resolves.toBe(
        "isolated reopened",
      );
    } finally {
      isolatedGate.release();
      finishOrdinary.resolve();
      await Promise.all([ordinary, isolated]);
    }
    expect(admission.retainedBytes).toBe(0);
  },
);

await initializeSqliteRuntimeCapabilities();
const { databasePath } = useSqliteWorkerStoreFixture("sqlite-capacity-drain-");
it.for(["shared-state", "agent"] as const)(
  "keeps one physical owner across %s and ordinary opens",
  async (carrierClass, { signal }) => {
    const pathname = databasePath();
    const alias = `${pathname}.alias`;
    using database = openNodeSqliteDatabase(pathname);
    database.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    admitSqliteSchema(database);
    linkSync(pathname, alias);
    const acquired = createDeferredCore();
    let count = 0;
    const createLifecycle = workerLifecycle.createSqliteWorkerLifecycle;
    using _ = vi
      .spyOn(workerLifecycle, "createSqliteWorkerLifecycle")
      .mockImplementation((options) => {
        const lifecycle = createLifecycle(options);
        const acquireSlot = lifecycle.acquireSlot;
        lifecycle.acquireSlot = async (...args) => {
          const slot = await acquireSlot(...args);
          if (++count === 2) {
            acquired.resolve();
          }
          await acquired.promise;
          return slot;
        };
        return lifecycle;
      });
    const broker = new SqliteWorkerBroker();
    const options = {
      moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
      databasePath: pathname,
      existingOnly: true,
      input: undefined,
    };
    const opening = Promise.allSettled([
      broker.open<FixtureOperations>(options, undefined, undefined, { carrierClass }),
      broker.open<FixtureOperations>({ ...options, databasePath: alias }),
    ]);
    try {
      const outcomes = await withinTest(opening, signal);
      const store = outcomes.find((outcome) => outcome.status === "fulfilled")?.value;
      assert(store);
      expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
        reason: { code: "overloaded", message: expect.stringContaining("retry open") },
      });
      await appendWorkerRow(store, "still owned");
      await expect(readWorkerRows(store)).resolves.toEqual(["still owned"]);
    } finally {
      acquired.resolve();
      await broker.close();
    }
  },
);

it("joins host drainage during reclamation without cycling through open admission", async () => {
  const broker = new SqliteWorkerBroker();
  const options = {
    moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
    databasePath: databasePath(),
    input: undefined,
  };
  let draining: Promise<void> | undefined;
  try {
    const first = await broker.open(options, undefined, undefined, {
      retireIdle: (): Promise<void> => {
        assert(first);
        const closing = first.close();
        draining = broker.close();
        return closing;
      },
    });
    for (let index = 1; index < 64; index++) {
      await broker.open(options);
    }
    await expect(broker.open(options)).rejects.toMatchObject({ code: "closed" });
    expect(draining).toBeDefined();
    await draining;
  } finally {
    await broker.close();
  }
});

it("selects idle store clients past the retain limit", () => {
  const now = 1_700_000_000_000;
  const idle = {
    isIdle: () => true,
    lastUsedAt: now - 60_000,
  } as unknown as StoreClient;
  const busy = {
    isIdle: () => false,
    lastUsedAt: now,
  } as unknown as StoreClient;
  const selected = selectIdleSqliteWorkerClients([busy, idle], {
    retainLimit: 0,
    idleTtlMs: 30_000,
    now,
    force: false,
  });
  expect(selected).toEqual([idle]);
});

it("keeps a recently used client out of the idle sweep", () => {
  const now = 1_700_000_000_000;
  const fresh = {
    isIdle: () => true,
    lastUsedAt: now - 1_000,
  } as unknown as StoreClient;
  const selected = selectIdleSqliteWorkerClients([fresh], {
    retainLimit: 0,
    idleTtlMs: 30_000,
    now,
    force: false,
  });
  expect(selected).toEqual([]);
});

it("selects every idle client when the sweep is forced", () => {
  const now = 1_700_000_000_000;
  const idle = {
    isIdle: () => true,
    lastUsedAt: now,
  } as unknown as StoreClient;
  const selected = selectIdleSqliteWorkerClients([idle], {
    retainLimit: 64,
    idleTtlMs: 30_000,
    now,
    force: true,
  });
  expect(selected).toEqual([idle]);
});

it("reads the store cap from the environment", () => {
  const previous = process.env.OPENCLAW_SQLITE_WORKER_MAX_STORES;
  try {
    process.env.OPENCLAW_SQLITE_WORKER_MAX_STORES = "192";
    expect(resolveSqliteWorkerStoreCap()).toBe(192);
    process.env.OPENCLAW_SQLITE_WORKER_MAX_STORES = "not-a-number";
    expect(resolveSqliteWorkerStoreCap()).toBe(64);
    process.env.OPENCLAW_SQLITE_WORKER_MAX_STORES = "0";
    expect(resolveSqliteWorkerStoreCap()).toBe(64);
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCLAW_SQLITE_WORKER_MAX_STORES;
    } else {
      process.env.OPENCLAW_SQLITE_WORKER_MAX_STORES = previous;
    }
  }
});
