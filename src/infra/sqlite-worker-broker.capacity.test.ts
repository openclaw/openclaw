import assert from "node:assert/strict";
import { linkSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { createDeferredCore } from "../shared/deferred.js";
import { initializeSqliteRuntimeCapabilities } from "./bun-sqlite-library.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { admitSqliteSchema } from "./sqlite-schema-facts.js";
import {
  captureSqliteWorkerOpen,
  reclaimSqliteWorkerClient,
  reserveSqliteWorkerClient,
} from "./sqlite-worker-broker-admission.js";
import * as workerLifecycle from "./sqlite-worker-broker-lifecycle.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import { createSqliteWorkerClient } from "./sqlite-worker-client.js";
import { createSqliteWorkerClientActor } from "./sqlite-worker-client.test-support.js";
import {
  useSqliteWorkerStoreFixture,
  readWorkerRows,
  appendWorkerRow,
} from "./sqlite-worker-fixture.test-support.js";
import { SqliteWorkerInputAdmission } from "./sqlite-worker-input-admission.js";
import type { FixtureOperations } from "./sqlite-worker-store.test-support.js";

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

it("admits cold shared state while an agent opens, with one shared input budget", async () => {
  const admission = inputAdmission();
  const finishAgent = createDeferredCore();
  const sharedStarted = createDeferredCore();
  const finishShared = createDeferredCore();
  const openShared = <T>(bytes: number, run: () => Promise<T>) =>
    admission.open(bytes, run, undefined, undefined, true);
  const agent = admission.open(512, () => finishAgent.promise);
  const shared = openShared(512, async () => {
    sharedStarted.resolve();
    await finishShared.promise;
  });
  try {
    await sharedStarted.promise;
    await expect(admission.open(1, async () => {})).rejects.toMatchObject({ code: "overloaded" });
    finishShared.resolve();
    await shared;
    expect(admission.retainedBytes).toBe(512);
    await expect(openShared(513, async () => {})).rejects.toMatchObject({ code: "overloaded" });
    await expect(openShared(512, async () => "shared reopened")).resolves.toBe("shared reopened");
  } finally {
    finishShared.resolve();
    finishAgent.resolve();
    await Promise.all([agent, shared]);
  }
  expect(admission.retainedBytes).toBe(0);
});

await initializeSqliteRuntimeCapabilities();
const { databasePath } = useSqliteWorkerStoreFixture("sqlite-capacity-drain-");
it("keeps one physical owner when shared and ordinary opens acquire carriers together", async ({
  signal,
}) => {
  const pathname = databasePath();
  const alias = `${pathname}.alias`;
  const database = openNodeSqliteDatabase(pathname);
  database.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  admitSqliteSchema(database);
  linkSync(pathname, alias);
  const acquired = createDeferredCore();
  let count = 0;
  const createLifecycle = workerLifecycle.createSqliteWorkerLifecycle;
  const lifecycleSpy = vi
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
    broker.open<FixtureOperations>(options, undefined, undefined, { sharedState: true }),
    broker.open<FixtureOperations>({ ...options, databasePath: alias }),
  ]);
  try {
    const outcomes = await withinTest(opening, signal);
    const opened = outcomes.flatMap((outcome) =>
      outcome.status === "fulfilled" && outcome.value ? [outcome.value] : [],
    );
    expect(opened).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
      reason: { code: "overloaded", message: expect.stringContaining("retry open") },
    });
    const store = opened[0]!;
    await appendWorkerRow(store, "still owned");
    await expect(readWorkerRows(store)).resolves.toEqual(["still owned"]);
  } finally {
    acquired.resolve();
    const outcomes = await opening;
    await Promise.all(
      outcomes.flatMap((outcome) =>
        outcome.status === "fulfilled" && outcome.value ? [outcome.value.close()] : [],
      ),
    );
    await broker.close();
    lifecycleSpy.mockRestore();
    database.close();
  }
});

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
