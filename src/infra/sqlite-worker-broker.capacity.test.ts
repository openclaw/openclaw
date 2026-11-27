import assert from "node:assert/strict";
import fs, { linkSync, symlinkSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  nextEventLoopTurn,
  withinTest,
} from "../../test/helpers/promise.js";
import { createEnteredGate } from "../agents/entered-gate.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { initializeSqliteRuntimeCapabilities } from "./bun-sqlite-library.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runWithSqliteDatabaseAdmissionTurn } from "./sqlite-database-admission-turn.js";
import { getSqliteDatabaseAdmissionIdentityForPath } from "./sqlite-database-admission.js";
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
import { SqliteWorkerError } from "./sqlite-worker-contract.js";
import {
  holdCreatedFileCallback,
  type SqliteFixtureOpenArguments as OpenArguments,
  useSqliteWorkerStoreFixture,
  readWorkerRows,
  appendWorkerRow,
} from "./sqlite-worker-fixture.test-support.js";
import * as workerIdentity from "./sqlite-worker-identity.js";
import { SqliteWorkerInputAdmission } from "./sqlite-worker-input-admission.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
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
    admission.open(0, databasePath(), open, undefined, kind === "reused" ? open : undefined),
    admission.open(0, databasePath(), async () => {}),
  ];
  const joined = admission.joinOpens().then(() => finished);
  try {
    await expect(admission.open(0, databasePath(), async () => {})).rejects.toMatchObject({
      code: "overloaded",
    });
    if (kind === "reused") {
      await pending[1];
    }
  } finally {
    finish.resolve();
    await Promise.all(pending);
  }
  expect(await joined).toBe(true);
  await expect(admission.open(0, databasePath(), async () => "admitted")).resolves.toBe("admitted");
  expect(admission.retainedBytes).toBe(0);
});

it("reserves cold admission synchronously before a later database turn", async () => {
  const admission = inputAdmission();
  const file = databasePath();
  const order: string[] = [];
  const opening = admission.open(1, file, async () => order.push("open"));
  const later = runWithSqliteDatabaseAdmissionTurn([file], async () => order.push("later"));
  await Promise.all([opening, later, admission.joinOpens()]);
  expect(order).toEqual(["open", "later"]);
  expect(admission.retainedBytes).toBe(0);
});

it.for(["ELOOP", "EACCES"])(
  "releases cold open custody after discovery fails with %s",
  async (code, { signal, skip }) => {
    if (code === "ELOOP" && process.platform === "win32") {
      skip(); // File symlinks require privileges on Windows.
    }
    const admission = inputAdmission();
    const file = databasePath();
    if (code === "ELOOP") {
      symlinkSync(file, file);
    } else {
      // A permission error must be deterministic even when tests run as root.
      vi.spyOn(workerIdentity, "inspectDatabasePathIdentity").mockRejectedValueOnce(
        Object.assign(new Error("permission denied"), { code }),
      );
    }
    const dispatch = vi.fn(async () => "unreachable");
    await expect(admission.open(1024, file, dispatch)).rejects.toMatchObject({ code });
    expect(dispatch).not.toHaveBeenCalled();
    expect(admission.retainedBytes).toBe(0);
    await withinTest(admission.joinOpens(), signal);
    await expect(admission.open(1024, databasePath(), async () => "recovered")).resolves.toBe(
      "recovered",
    );
  },
);

it.each(["shared-state", "agent", "external"] as const)(
  "admits cold %s beside ordinary opens within one input budget",
  async (carrierClass) => {
    const admission = inputAdmission();
    const finishOrdinary = createDeferredCore();
    const isolatedGate = createEnteredGate();
    const openIsolated = <T>(bytes: number, run: () => Promise<T>) =>
      admission.open(bytes, databasePath(), run, undefined, undefined, carrierClass);
    const ordinary = admission.open(512, databasePath(), () => finishOrdinary.promise);
    const isolated = openIsolated(512, isolatedGate.wait);
    try {
      await isolatedGate.entered;
      await expect(admission.open(1, databasePath(), async () => {})).rejects.toMatchObject({
        code: "overloaded",
      });
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
it("settles cold admission filesystem failures before draining the broker", async () => {
  const pathname = databasePath();
  const failure = Object.assign(new Error("cold database permission denied"), { code: "EACCES" });
  const inspect = workerIdentity.inspectDatabasePathIdentity;
  using _ = vi
    .spyOn(workerIdentity, "inspectDatabasePathIdentity")
    .mockImplementation(async (...args) => {
      if (args[0] === pathname) {
        throw failure;
      }
      return inspect(...args);
    });
  const broker = new SqliteWorkerBroker();
  await expect(
    broker.open({
      moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
      databasePath: pathname,
      input: undefined,
    }),
  ).rejects.toBe(failure);
  await broker.close();
});

it.for(["shared-state", "agent", "external"] as const)(
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

it.for(["before submission", "after descriptor accounting"] as const)(
  "records cold creation cancellation %s without cleanup uncertainty",
  async (phase, { signal }) => {
    const pathname = databasePath();
    const broker = new SqliteWorkerBroker();
    const inspecting = createEnteredGate();
    const revoked = new Error("Fixture opening authority revoked");
    let current = true;
    let submitted = false;
    let held = false;
    let admission: ReturnType<typeof createSqliteWorkerOperationAdmission> | undefined;
    const inspect = workerIdentity.inspectDatabasePathIdentity;
    const inspectSpy = vi
      .spyOn(workerIdentity, "inspectDatabasePathIdentity")
      .mockImplementation(async (...args) => {
        const observed = await inspect(...args);
        if (
          args[0] === pathname &&
          !held &&
          submitted === (phase === "after descriptor accounting")
        ) {
          held = true;
          await inspecting.wait();
        }
        return observed;
      });
    const open = fs.open;
    const openSpy = vi.spyOn(fs, "open").mockImplementation((...args: OpenArguments) => {
      if (args.length === 2) {
        return open(...args);
      }
      if (args.length === 3) {
        return open(...args);
      }
      const [file, flags, mode, callback] = args;
      if (String(file) === pathname && flags === "wx") {
        submitted = true;
      }
      return open(file, flags, mode, callback);
    });
    using _ = {
      [Symbol.dispose]() {
        openSpy.mockRestore();
        inspectSpy.mockRestore();
      },
    };
    const assertCurrent = () => {
      if (!current) {
        throw revoked;
      }
    };
    const opening = broker.open<FixtureOperations>(
      {
        moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
        databasePath: pathname,
        input: undefined,
      },
      undefined,
      assertCurrent,
      {
        createAdmission() {
          admission = createSqliteWorkerOperationAdmission((_request, grant) => {
            assertCurrent();
            grant();
          });
          return { admission, nativeLocations: [pathname] };
        },
      },
    );
    const outcome = Promise.allSettled([opening]);
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          inspecting.entered,
          opening,
          "Cold opening settled before physical qualification",
        ),
        signal,
      );
      expect(fs.existsSync(pathname)).toBe(phase === "after descriptor accounting");
      current = false;
      inspecting.release();
      await withinTest(outcome, signal);
      if (phase === "after descriptor accounting") {
        expect(admission?.failure).toBe(revoked);
      }
      expect(admission?.cleanupFailures ?? []).toEqual([]);
      if (phase === "after descriptor accounting") {
        await expect(opening).rejects.toBeInstanceOf(SqliteWorkerError);
        await expect(opening).rejects.toMatchObject({
          message: "SQLite admission facts exchange failed",
          code: "unavailable",
        });
      } else {
        await expect(opening).rejects.toBe(revoked);
      }
      expect(fs.existsSync(pathname)).toBe(phase === "after descriptor accounting");
      if (submitted) {
        expect(fs.statSync(pathname).size).toBe(0);
      }
    } finally {
      inspecting.release();
      await outcome;
      await broker.close();
    }
  },
);

it.for([false, true])(
  "joins accepted cold creation after native exit (physical accounting failure: %s)",
  async (failAccounting, { signal }) => {
    const pathname = databasePath();
    const broker = new SqliteWorkerBroker();
    using creation = holdCreatedFileCallback(pathname);
    const physicalFailure = new Error("Fixture returned descriptor could not be inspected");
    let admission: ReturnType<typeof createSqliteWorkerOperationAdmission> | undefined;
    const nativeSettled = vi.fn();
    const completed = vi.fn();
    const drained = vi.fn();
    const fstat = fs.fstat;
    using _ = vi.spyOn(fs, "fstat").mockImplementation((fd, options, callback) => {
      return fstat(fd, options, (error, stats) =>
        callback(failAccounting && fd === creation.descriptor ? physicalFailure : error, stats),
      );
    });
    const requests = vi.spyOn(Worker.prototype, "postMessage");
    const opening = broker.open<FixtureOperations>(
      {
        moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
        databasePath: pathname,
        input: undefined,
      },
      undefined,
      undefined,
      {
        createAdmission(operation) {
          void operation.settled.then(nativeSettled);
          admission = createSqliteWorkerOperationAdmission((_request, grant) => grant());
          return { admission, nativeLocations: [pathname] };
        },
      },
    );
    const outcome = Promise.allSettled([opening]).then((result) => {
      completed();
      return result;
    });
    let drainage: Promise<void> | undefined;
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          creation.entered,
          opening,
          "Cold opening bypassed asynchronous host creation",
        ),
        signal,
      );
      expect(fs.existsSync(pathname)).toBe(true);
      expect(fs.statSync(pathname).size).toBe(0);
      assert(admission, "Expected the actual creating admission");
      const creatingAdmission = admission;
      expect(() => creatingAdmission.abortConstruction()).toThrow(
        "SQLite admission construction has already received work",
      );
      const index = requests.mock.calls.findIndex(
        ([request]) => request.type === "open" && request.databasePath === pathname,
      );
      const carrier = requests.mock.contexts[index];
      assert(carrier instanceof Worker, "Expected the actual creating native carrier");
      await withinTest(carrier.terminate(), signal);
      await nextEventLoopTurn();
      expect(completed).not.toHaveBeenCalled();
      expect(nativeSettled).not.toHaveBeenCalled();
      expect(() => broker.reserveInputPreparation(256 * 1024 * 1024, "snapshot")).toThrow(
        expect.objectContaining({ code: "overloaded" }),
      );
      drainage = broker.close().then(drained);
      await nextEventLoopTurn();
      expect(drained).not.toHaveBeenCalled();
      creation.release();
      const result = await withinTest(outcome, signal);
      expect(result[0]).toMatchObject({ status: "rejected" });
      await withinTest(drainage, signal);
      expect(completed).toHaveBeenCalledOnce();
      expect(nativeSettled).toHaveBeenCalledOnce();
      expect(nativeSettled.mock.calls[0]?.[0]).toMatchObject({
        kind: "unknown",
        nativeStopped: true,
      });
      expect(admission?.cleanupFailures).toEqual(failAccounting ? [physicalFailure] : []);
      expect(fs.statSync(pathname).size).toBe(0);
    } finally {
      creation.release();
      requests.mockRestore();
      await outcome;
      await (drainage ?? broker.close());
      // The failed-fstat fixture alone knows this fd; all native owners have now stopped.
      if (failAccounting && creation.descriptor !== undefined) {
        fs.closeSync(creation.descriptor);
      }
    }
  },
);

it("keeps created admission published when a queued turn carries earlier absence", async ({
  signal,
}) => {
  const pathname = databasePath();
  const absent = await workerIdentity.readDatabasePathIdentity(pathname);
  expect(absent.key.startsWith("file:")).toBe(false);
  const broker = new SqliteWorkerBroker();
  using creation = holdCreatedFileCallback(pathname);
  const options = {
    moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
    databasePath: pathname,
    input: undefined,
  };
  const opening = broker.open<FixtureOperations>(options);
  const openingOutcome = Promise.allSettled([opening]);
  let later: Promise<void> | undefined;
  let laterOutcome: Promise<PromiseSettledResult<void>[]> | undefined;
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        creation.entered,
        opening,
        "Expected actual cold creation before queued turn",
      ),
      signal,
    );
    later = runWithSqliteDatabaseAdmissionTurn(
      [pathname],
      async () => {
        expect(getSqliteDatabaseAdmissionIdentityForPath(pathname)).toMatchObject({
          key: expect.stringMatching(/^file:/u),
        });
        const store = await broker.open<FixtureOperations>({ ...options, existingOnly: true });
        assert(store, "Created store must remain admitted");
        await appendWorkerRow(store, "after captured absence");
        expect(await readWorkerRows(store)).toEqual(["after captured absence"]);
      },
      [],
      undefined,
      { readIdentities: new Map([[pathname, absent]]) },
    );
    laterOutcome = Promise.allSettled([later]);
    await nextEventLoopTurn();
    creation.release();
    const [store] = await withinTest(Promise.all([opening, later]), signal);
    assert(store, "Initial creator must finish successfully");
    expect(await readWorkerRows(store)).toEqual(["after captured absence"]);
  } finally {
    creation.release();
    await openingOutcome;
    await laterOutcome;
    await broker.close();
  }
});
