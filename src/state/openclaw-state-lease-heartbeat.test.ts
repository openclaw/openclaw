import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  getEnvironmentData,
  MessageChannel,
  Worker,
  type WorkerOptions,
} from "node:worker_threads";
import pg from "pg";
import { afterEach, assert, describe, expect, it as baseIt, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import { createSqliteFamilyEngines } from "../infra/database-engine/selection-fixture.test-support.js";
import { defaultPayload } from "../infra/gateway-state-owner-record.js";
import { resolveGatewayStateOwnerPath } from "../infra/gateway-state-owner.js";
import { resolveRuntimeWorkerThreadExecArgv } from "../infra/runtime-worker-url.js";
import {
  readSqliteDatabaseWriteRevision,
  trackSqliteDatabaseAdmissionWorker,
} from "../infra/sqlite-database-admission.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { createSqliteDatabaseAdmissionRelay } from "../infra/sqlite-worker-operation-admission.js";
import { createUpdateErrorFact } from "../infra/update-failure-facts.js";
import { createDeferredCore } from "../shared/deferred.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { holdStateDatabaseWriteTransaction } from "../test-utils/state-database-contention.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import {
  cleanupPostgresStateFixture,
  installPostgresStateFixture,
} from "./openclaw-state-db.postgres-fixture.test-support.js";
import {
  leaseHeartbeatState,
  type LeaseHeartbeatWorkerData,
} from "./openclaw-state-lease-heartbeat-shared.js";
import { startOpenClawStateLeaseHeartbeat } from "./openclaw-state-lease-heartbeat.js";
import { acquireOpenClawStateLeaseInTransaction } from "./openclaw-state-lease-store.js";
import { runWithOpenClawStateLeaseWorker } from "./openclaw-state-lease-worker-operation.js";
import { withOpenClawStateLease, type OpenClawStateLeaseContext } from "./openclaw-state-lease.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

const it = baseIt.extend<{ state: OpenClawTestState }>({
  state: async ({ task }, use) => {
    await withOpenClawTestState({ label: task.name }, use);
  },
});

const heartbeatWorkers = vi.hoisted(() => ({
  startupDelayMs: 0,
  beforeCreate: undefined as (() => void) | undefined,
  onCreate: undefined as ((worker: Worker, options: WorkerOptions) => void) | undefined,
}));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const [{ runtimeProcessEntrypoints }, { resolveRuntimeWorkerUrl }] = await Promise.all([
    import("../infra/runtime-process-entrypoints.js"),
    import("../infra/runtime-worker-url.js"),
  ]);
  const heartbeatUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.stateLeaseHeartbeat);
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, workerOptions: WorkerOptions = {}) {
        if (String(filename) === heartbeatUrl.href) {
          heartbeatWorkers.beforeCreate?.();
        }
        const delayedFilename =
          String(filename) === heartbeatUrl.href && heartbeatWorkers.startupDelayMs > 0
            ? new URL(
                `data:text/javascript,${encodeURIComponent(`await new Promise(resolve => setTimeout(resolve, ${heartbeatWorkers.startupDelayMs})); await import(${JSON.stringify(String(filename))});`)}`,
              )
            : filename;
        super(delayedFilename, workerOptions);
        if (String(filename) === heartbeatUrl.href) {
          heartbeatWorkers.onCreate?.(this, workerOptions);
        }
      }
    },
  };
});

function nextHeartbeatWorker(): Promise<Worker> {
  return new Promise((resolve) => {
    heartbeatWorkers.onCreate = resolve;
  });
}

function block(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function options(env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  return {
    scope: "core:test-maintenance",
    key: "maintenance",
    database: { scope: "shared" as const, options: { env } },
    leaseMs: 1_000,
    waitMs: 0,
    heartbeat: "worker" as const,
    signal,
  };
}

function readLease(env: NodeJS.ProcessEnv) {
  return openOpenClawStateDatabase({ env })
    .db.prepare(
      "SELECT owner, expires_at, heartbeat_at FROM state_leases WHERE scope = ? AND lease_key = ?",
    )
    .get("core:test-maintenance", "maintenance");
}

afterEach(() => {
  heartbeatWorkers.startupDelayMs = 0;
  heartbeatWorkers.beforeCreate = undefined;
  heartbeatWorkers.onCreate = undefined;
  closeOpenClawStateDatabaseForTest();
});

describe("maintenance lease heartbeat", () => {
  it.for([0, 1])(
    "shares renewal without closing sibling lease %s",
    async (closing, { signal, state }) => {
      const workers: Worker[] = [];
      heartbeatWorkers.onCreate = (worker) => workers.push(worker);
      const entered = [createDeferredCore(), createDeferredCore()];
      const release = [createDeferredCore(), createDeferredCore()];
      const leases: OpenClawStateLeaseContext[] = [];
      const operations = [0, 1].map((index) =>
        withOpenClawStateLease(
          { ...options(state.env), key: `lease-${index}`, leaseMs: 10_000 },
          async (lease) => {
            leases[index] = lease;
            entered[index]!.resolve();
            await release[index]!.promise;
          },
        ),
      );
      void Promise.allSettled(operations);
      try {
        await withinTest(Promise.all(entered.map((entry) => entry.promise)), signal);
        expect(workers).toHaveLength(1);
        release[closing]!.resolve();
        await withinTest(operations[closing]!, signal);
        const sibling = leases[1 - closing]!;
        sibling.renew?.();
        expect(() => sibling.assertOwned()).not.toThrow();
        expect(sibling.signal.aborted).toBe(false);
      } finally {
        release.forEach((entry) => entry.resolve());
        await Promise.allSettled(operations);
      }
      expect(workers[0]?.threadId).toBe(-1);
    },
  );

  it("releases an existing-schema lease refused by maintenance during heartbeat startup", async ({
    state,
  }) => {
    const database = openOpenClawStateDatabase({ env: state.env });
    const leaseOptions = {
      ...options(state.env),
      database: { ...options(state.env).database, schemaPolicy: "existing" as const },
      leaseMs: 60_000,
    };
    const ownerPath = resolveGatewayStateOwnerPath(database.path);
    const holder = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    await once(holder, "spawn");
    const stopped = once(holder, "exit");
    let entered = false;
    heartbeatWorkers.beforeCreate = () => {
      fs.mkdirSync(path.dirname(ownerPath), { recursive: true });
      fs.writeFileSync(
        ownerPath,
        JSON.stringify({ ...defaultPayload(database.path), pid: holder.pid, startTime: undefined }),
      );
    };
    try {
      await expect(
        withOpenClawStateLease(leaseOptions, async () => {
          entered = true;
        }),
      ).rejects.toThrow();
      expect(entered).toBe(false);
      // Custody still blocks cleanup: no release or protected callback may bypass it.
      expect(
        database.db
          .prepare("SELECT owner FROM state_leases WHERE scope = ? AND lease_key = ?")
          .get("core:test-maintenance", "maintenance"),
      ).toBeDefined();
      fs.rmSync(ownerPath);
      heartbeatWorkers.beforeCreate = undefined;
      // Retry must release the original row, not wait for its minute-long expiry.
      await expect(
        withOpenClawStateLease({ ...leaseOptions, waitMs: 2_000 }, async (lease) => {
          lease.assertOwned();
          return "reacquired";
        }),
      ).resolves.toBe("reacquired");
      expect(readLease(state.env)).toBeUndefined();
    } finally {
      heartbeatWorkers.beforeCreate = undefined;
      fs.rmSync(ownerPath, { force: true });
      holder.kill();
      await stopped;
    }
  });

  it("preserves native renewal errors through worker and lease rejection", async ({ state }) => {
    const { db } = openOpenClawStateDatabase({ env: state.env });
    // Inject only after schema validation/acquisition, and remove before release.
    heartbeatWorkers.beforeCreate = () => {
      db.exec(`CREATE TRIGGER fail_renewal BEFORE UPDATE ON state_leases
      WHEN OLD.scope = 'core:test-maintenance'
      BEGIN SELECT RAISE(ABORT, 'synthetic renewal failure'); END`);
    };
    heartbeatWorkers.onCreate = (worker) => {
      worker.once("exit", () => db.exec("DROP TRIGGER fail_renewal"));
    };
    await expect(
      withOpenClawStateLease({ ...options(state.env), leaseMs: 60_000 }, async () => {
        throw new Error("must not enter maintenance");
      }),
    ).rejects.toMatchObject({
      code: "OPENCLAW_STATE_LEASE_LOST",
      loss: { reason: "storage-failed" },
      cause: {
        message: expect.stringContaining("synthetic renewal failure"),
        cause: {
          name: "Error",
          message: "synthetic renewal failure",
          code: "ERR_SQLITE_ERROR",
          errcode: 1811,
          attempt: 1,
        },
      },
    });
    expect(readLease(state.env)).toBeUndefined();
  });

  it("preserves native startup renewals beyond the initial lease expiry", async ({ state }) => {
    openOpenClawStateDatabase({ env: state.env });
    heartbeatWorkers.startupDelayMs = 1_500;
    const entered = vi.fn(async (lease: OpenClawStateLeaseContext) => lease.assertOwned());
    await withOpenClawStateLease(options(state.env), entered);
    expect(entered).toHaveBeenCalledOnce();
    expect(readLease(state.env)).toBeUndefined();
  });

  it("rejects expired startup while parent callbacks are blocked", async ({ state }) => {
    const { db } = openOpenClawStateDatabase({ env: state.env });
    heartbeatWorkers.onCreate = () => {
      db.exec("BEGIN IMMEDIATE");
      try {
        block(1_200);
      } finally {
        db.exec("ROLLBACK");
      }
    };
    const entered = vi.fn();
    await expect(withOpenClawStateLease(options(state.env), entered)).rejects.toMatchObject({
      code: "OPENCLAW_STATE_LEASE_LOST",
    });
    expect(entered).not.toHaveBeenCalled();
    expect(readLease(state.env)).toBeUndefined();
  });

  it("retains ownership during synchronous maintenance past expiry", async ({ state }) => {
    await withOpenClawStateLease({ ...options(state.env), leaseMs: 10_000 }, async (lease) => {
      block(10_250);
      expect(() => lease.renew?.()).not.toThrow();
      expect(() => lease.assertOwned()).not.toThrow();
      expect(lease.signal.aborted).toBe(false);
    });
  });

  it("renews through transient contention before expiry", async ({ state }) => {
    const database = openOpenClawStateDatabase({ env: state.env });
    await withOpenClawStateLease({ ...options(state.env), leaseMs: 1_500 }, async (lease) => {
      const holder = holdStateDatabaseWriteTransaction(database.path, 1_200);
      try {
        await holder.ready;
        await holder.joined;
        block(400);
        expect(() => lease.assertOwned()).not.toThrow();
        expect(lease.signal.aborted).toBe(false);
      } finally {
        holder.release();
        await holder.joined;
      }
    });
  });

  it("rejects a terminated heartbeat worker", async ({ state }) => {
    const spawned = nextHeartbeatWorker();
    await expect(
      withOpenClawStateLease({ ...options(state.env), leaseMs: 10_000 }, async (lease) => {
        const worker = await spawned;
        await worker.terminate();
        expect(Number(readLease(state.env)?.expires_at)).toBeGreaterThan(Date.now());
        expect(() => lease.assertOwned()).toThrowError(
          expect.objectContaining({ code: "OPENCLAW_STATE_LEASE_LOST" }),
        );
      }),
    ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
    expect(readLease(state.env)).toBeUndefined();
  });

  it("accepts published readiness without parent notification", async ({ state }) => {
    const spawned = nextHeartbeatWorker();
    const operation = withOpenClawStateLease(
      { ...options(state.env), leaseMs: 10_000 },
      async (lease) => {
        lease.assertOwned();
        return "maintained";
      },
    );
    const worker = await spawned;
    try {
      expect(worker.listenerCount("message")).toBe(1);
      // Withhold only the owner's notification; the real worker still renews
      // and publishes ready before our observer sees its startup message.
      worker.removeAllListeners("message");
      await Promise.race([once(worker, "message"), operation]);
      await expect(operation).resolves.toBe("maintained");
      expect(readLease(state.env)).toBeUndefined();
    } finally {
      await worker.terminate();
      await operation.catch(() => {});
    }
  });

  it.for(["replacement", "expiry", "deletion"] as const)(
    "does not resurrect ownership after %s",
    async (failure, { state }) => {
      let observation: BigInt64Array | undefined;
      heartbeatWorkers.onCreate = (_worker, workerOptions) => {
        observation = new BigInt64Array(workerOptions.workerData.shared);
      };
      let fact: ReturnType<typeof createUpdateErrorFact> | undefined;
      let observedStatus: bigint | undefined;
      let after: ReturnType<typeof readLease>;
      const reason = {
        replacement: "replaced",
        expiry: "expired",
        deletion: "missing",
      }[failure];
      let changed: ReturnType<typeof readLease>;
      await expect(
        withOpenClawStateLease({ ...options(state.env), leaseMs: 1_000 }, async (lease) => {
          runOpenClawStateWriteTransaction(
            ({ db }) => {
              if (failure === "deletion") {
                db.prepare("DELETE FROM state_leases WHERE scope = ?").run("core:test-maintenance");
              } else {
                db.prepare(
                  `UPDATE state_leases SET ${failure === "replacement" ? "owner = 'successor'" : "expires_at = 0"} WHERE scope = ?`,
                ).run("core:test-maintenance");
              }
            },
            { env: state.env },
          );
          changed = readLease(state.env);
          block(450);
          observedStatus = Atomics.load(observation!, leaseHeartbeatState.status);
          try {
            lease.assertOwned();
          } catch {
            /* The owner also rejects at scope exit. */
          }
          fact = createUpdateErrorFact("doctor", lease.signal.reason, state.env);
          after = readLease(state.env);
        }),
      ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST", loss: { reason } });
      expect(observedStatus).toBe(leaseHeartbeatState.lost);
      expect(fact).toMatchObject({
        message: expect.stringContaining("state lease core:test-maintenance/maintenance was lost"),
        leaseLoss: {
          reason,
        },
      });
      expect(after).toEqual(changed);
      expect(readLease(state.env)).toEqual(failure === "replacement" ? changed : undefined);
    },
  );

  it.for(["throw", "abort"] as const)(
    "stops renewal and retained callbacks when an operation ends by %s",
    async (ending, { state }) => {
      const controller = new AbortController();
      const spawned = nextHeartbeatWorker();
      let retained: OpenClawStateLeaseContext | undefined;
      const operation = withOpenClawStateLease(
        { ...options(state.env, controller.signal), leaseMs: 10_000 },
        async (lease) => {
          retained = lease;
          if (ending === "abort") {
            const worker = await spawned;
            controller.abort();
            await once(worker, "exit");
            const stopped = readLease(state.env);
            await new Promise((resolve) => {
              setTimeout(resolve, 450);
            });
            expect(readLease(state.env)).toEqual(stopped);
          } else if (ending === "throw") {
            throw new Error("operation failed");
          }
          return "completed";
        },
      );
      await expect(operation).rejects.toThrow(
        ending === "throw" ? "operation failed" : "was aborted",
      );
      const worker = await spawned;
      expect(worker.threadId).toBe(-1);
      expect(readLease(state.env)).toBeUndefined();
      expect(retained).toBeDefined();
      expect(() => retained?.assertOwned()).toThrow();
      expect(() => retained?.renew?.()).toThrow();
    },
  );
});

it("defers SQLite activation until renewal commits without PostgreSQL runtime", async ({
  state,
  signal,
}) => {
  const database = openOpenClawStateDatabase({ env: state.env });
  const identity = { scope: "core:test", key: "activation", owner: "fixture-owner" };
  const acquired = runOpenClawStateWriteTransaction(
    ({ db }) => acquireOpenClawStateLeaseInTransaction(db, identity, 30_000),
    { database, env: state.env },
  );
  assert(acquired.kind === "acquired", "Fixture did not acquire its lease");
  const shared = new BigInt64Array(
    new SharedArrayBuffer((leaseHeartbeatState.ownerFence + 1) * BigInt64Array.BYTES_PER_ELEMENT),
  );
  Atomics.store(shared, leaseHeartbeatState.expiresAt, BigInt(acquired.expiresAt));
  const moduleUrl = pathToFileURL(
    path.resolve("src/state/openclaw-state-lease-heartbeat.worker.ts"),
  ).href;
  const loadGate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  // Observe completion of the real activation handler without adding a production test hook.
  const driver = await state.writeText(
    "activation-worker.mts",
    `
      import { parentPort, workerData } from "node:worker_threads";
      import nodeModule from "node:module";
      nodeModule.registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier.includes("openclaw-state-db-engine.")) {
            const gate = new Int32Array(workerData.fixtureLoadGate);
            if (Atomics.load(gate, 0) === 0) {
              throw new Error("SQLite heartbeat loaded PostgreSQL state runtime");
            }
            parentPort.postMessage({ fixture: "postgres-loading" });
            Atomics.wait(gate, 0, 1);
          }
          return nextResolve(specifier, context);
        },
      });
      if (!parentPort) throw new Error("Missing fixture parent port");
      const on = parentPort.on.bind(parentPort);
      parentPort.on = (event, listener) => event === "message"
        ? on(event, (message) => {
            Reflect.apply(listener, parentPort, [message]);
            if (message?.startup === "activate") {
              queueMicrotask(() => parentPort.postMessage({ fixture: "activation-processed" }));
            }
          })
        : on(event, listener);
      await import(${JSON.stringify(moduleUrl)});
    `,
  );
  const driverUrl = pathToFileURL(driver);
  const databaseAdmission = createSqliteDatabaseAdmissionRelay(() => {});
  const loss = new MessageChannel();
  const worker = new Worker(driverUrl, {
    workerData: {
      fixtureLoadGate: loadGate.buffer,
      databaseAdmissionPort: databaseAdmission.port,
      lossPort: loss.port2,
      path: database.path,
      expectedIdentity: readDatabasePathIdentitySync(database.path).key,
      identity,
      leaseMs: 30_000,
      acquiredAt: acquired.expiresAt - 30_000,
      heartbeatMs: 250,
      deferActivation: true,
      shared: shared.buffer,
      renewalProgress: new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT),
    } satisfies LeaseHeartbeatWorkerData & { fixtureLoadGate: SharedArrayBuffer },
    transferList: [databaseAdmission.port, loss.port2],
    execArgv: resolveRuntimeWorkerThreadExecArgv(driverUrl),
    env: {},
  });
  trackSqliteDatabaseAdmissionWorker(worker);
  const prepared = createDeferredCore();
  const processed = createDeferredCore();
  const ready = createDeferredCore();
  const failed = createDeferredCore<never>();
  void failed.promise.catch(() => {});
  const waitFor = (stage: ReturnType<typeof createDeferredCore<void>>) =>
    Promise.race([stage.promise, failed.promise]);
  worker.on("error", failed.reject);
  worker.once("exit", () => {
    failed.reject(new Error("Heartbeat fixture exited before activation completed"));
  });
  worker.on("message", (message: unknown) => {
    if (message === null) {
      ready.resolve();
    } else if (typeof message === "object" && message !== null) {
      if ("startup" in message && message.startup === "prepared") {
        prepared.resolve();
      }
      if ("fixture" in message && message.fixture === "activation-processed") {
        processed.resolve();
      }
    }
  });
  const writer = new DatabaseSync(database.path);
  try {
    await waitFor(prepared);
    const beforeRenewal = readSqliteDatabaseWriteRevision(database.db);
    writer.exec("BEGIN IMMEDIATE");
    worker.postMessage({ startup: "activate" }, []);
    await waitFor(processed);
    expect(Atomics.load(shared, leaseHeartbeatState.status)).toBe(leaseHeartbeatState.starting);
    writer.exec("ROLLBACK");
    await waitFor(ready);
    const afterRenewal = readSqliteDatabaseWriteRevision(database.db);
    expect([typeof beforeRenewal, typeof afterRenewal]).toEqual(["number", "number"]);
    expect(afterRenewal).not.toBe(beforeRenewal);
    expect(Atomics.load(shared, leaseHeartbeatState.status)).toBe(leaseHeartbeatState.ready);
    const row = database.db
      .prepare("SELECT expires_at FROM state_leases WHERE scope = ? AND lease_key = ?")
      .get(identity.scope, identity.key);
    expect(row?.expires_at).toBe(Number(Atomics.load(shared, leaseHeartbeatState.expiresAt)));
    expect(Number(row?.expires_at)).toBeGreaterThan(acquired.expiresAt);

    const registrationPort = new MessageChannel();
    const registrationLoss = new MessageChannel();
    const registrationAdmission = createSqliteDatabaseAdmissionRelay(() => {});
    const registrationState = new BigInt64Array(new SharedArrayBuffer(shared.byteLength));
    Atomics.store(
      registrationState,
      leaseHeartbeatState.expiresAt,
      Atomics.load(shared, leaseHeartbeatState.expiresAt),
    );
    try {
      const rejected = once(registrationPort.port1, "message");
      const loading = once(worker, "message");
      Atomics.store(loadGate, 0, 1);
      worker.postMessage(
        {
          registration: {
            path: database.path,
            expectedIdentity: readDatabasePathIdentitySync(database.path).key,
            identity: { ...identity, key: "later-postgres" },
            leaseMs: 30_000,
            acquiredAt: acquired.expiresAt - 30_000,
            heartbeatMs: 250,
            shared: registrationState.buffer,
            renewalProgress: new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT),
            databaseAdmissionPort: registrationAdmission.port,
            lossPort: registrationLoss.port2,
            databaseEngineSelection: {
              effectiveEngines: createSqliteFamilyEngines({ state: "postgres" }),
              postgres: { connection: "postgres://fixture.invalid/state", schemaPrefix: "fixture" },
            },
          } satisfies LeaseHeartbeatWorkerData,
          port: registrationPort.port2,
        },
        [registrationPort.port2, registrationLoss.port2, registrationAdmission.port],
      );
      expect(await withinTest(Promise.race([loading, failed.promise]), signal)).toEqual([
        { fixture: "postgres-loading" },
      ]);
      Atomics.store(registrationState, leaseHeartbeatState.status, leaseHeartbeatState.closed);
      Atomics.store(loadGate, 0, 2);
      Atomics.notify(loadGate, 0);
      expect(await withinTest(Promise.race([rejected, failed.promise]), signal)).toEqual([
        { startupError: "state lease heartbeat startup deadline expired or owner stopped" },
      ]);
      const renewed = once(worker, "message");
      worker.postMessage({ id: 1, operation: "renew" }, []);
      expect(await withinTest(Promise.race([renewed, failed.promise]), signal)).toEqual([
        { id: 1, ok: true, expiresAt: expect.any(Number) },
      ]);
      expect(Atomics.load(shared, leaseHeartbeatState.status)).toBe(leaseHeartbeatState.ready);
    } finally {
      Atomics.store(loadGate, 0, 2);
      Atomics.notify(loadGate, 0);
      await registrationAdmission.finish();
      registrationPort.port1.close();
      registrationPort.port2.close();
      registrationLoss.port1.close();
      registrationLoss.port2.close();
    }
  } finally {
    if (writer.isTransaction) {
      writer.exec("ROLLBACK");
    }
    writer.close();
    await worker.terminate();
    await databaseAdmission.finish();
    loss.port1.close();
    loss.port2.close();
  }
});

it("admits worker writes without host blocking and rolls back revoked commits", async ({
  state,
}) => {
  const database = openOpenClawStateDatabase({ env: state.env });
  const context = captureOpenClawStateWorkerContext({ env: state.env });
  const storeKey = "native-heartbeat-grants";
  await withOpenClawStateLease(
    { ...options(state.env), scope: "core:mcp-oauth", key: storeKey, leaseMs: 60_000 },
    async (lease) => {
      const sql = observeMainThreadSql();
      const wait = vi.spyOn(Atomics, "wait");
      const caller = new AbortController();
      const revoked = new Error("Synthetic caller authority was revoked");
      const write = (marker: string, revokeAtCommit = false) =>
        runWithOpenClawStateLeaseWorker(
          lease,
          context,
          (scope, identity) =>
            scope.execute({
              type: "mcpOAuth.writePending",
              input: { storeKey, identity, state: marker },
            }),
          {
            assertCurrent: () => caller.signal.throwIfAborted(),
            beforeCommit: () => {
              if (revokeAtCommit) {
                caller.abort(revoked);
              }
            },
          },
        );
      try {
        await write("accepted");
        await expect(write("refused", true)).rejects.toBe(revoked);
        sql.expectIdle();
        expect(wait).not.toHaveBeenCalled();
      } finally {
        sql.restore();
        wait.mockRestore();
      }
    },
  );
  expect(
    database.db
      .prepare("SELECT state FROM mcp_oauth_pending_authorizations WHERE store_key = ?")
      .all(storeKey),
  ).toEqual([{ state: "accepted" }]);
  expect(
    database.db
      .prepare("SELECT owner FROM state_leases WHERE scope = ? AND lease_key = ?")
      .all("core:mcp-oauth", storeKey),
  ).toEqual([]);
});

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;

describe.skipIf(!connection)("PostgreSQL state lease heartbeat reconnect", () => {
  const directories = useAutoCleanupTempDirTracker(afterEach);
  baseIt.each([false, true])(
    "recovers an interrupted renewal without reviving lost rows (ownership changed: %s)",
    async (replace) => {
      const directory = directories.make("state-heartbeat-reconnect-");
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: directory,
        OPENCLAW_CONFIG_PATH: path.join(directory, "openclaw.json"),
      };
      fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, "{}");
      installPostgresStateFixture(connection!, "heartbeat_reconnect");
      const client = new pg.Client({ connectionString: connection });
      const observer = new pg.Client({ connectionString: connection });
      await client.connect();
      await observer.connect();
      const heartbeats: ReturnType<typeof startOpenClawStateLeaseHeartbeat>[] = [];
      let namespace: string | undefined;
      let pathname = "";
      try {
        const database = withEngineStoreAdmission(() => openOpenClawStateDatabase({ env }));
        pathname = database.path;
        namespace = getPostgresPhysicalFacts(database.db)!.namespace;
        const table = `"${namespace}".state_leases`;
        const leaseMs = 30_000;
        const lost = [vi.fn(), vi.fn()];
        for (const [index, key] of ["first", "second"].entries()) {
          const identity = { scope: "core:test-heartbeat", key, owner: "original" };
          const acquired = withEngineStoreAdmission(() =>
            runOpenClawStateWriteTransaction(
              ({ db }) => acquireOpenClawStateLeaseInTransaction(db, identity, leaseMs),
              { database, env },
            ),
          );
          if (acquired.kind !== "acquired") {
            throw new Error("Fixture did not acquire its lease");
          }
          const heartbeat = startOpenClawStateLeaseHeartbeat({
            path: pathname,
            identity,
            leaseMs,
            acquiredAt: acquired.expiresAt - leaseMs,
            expiresAt: acquired.expiresAt,
            heartbeatMs: 100,
            onLost: lost[index]!,
          });
          heartbeats.push(heartbeat);
          await heartbeat.ready;
        }
        const rows = async () =>
          (await observer.query(`SELECT * FROM ${table} ORDER BY lease_key`)).rows;
        await client.query("BEGIN");
        await client.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
        const before = (await client.query(`SELECT * FROM ${table} ORDER BY lease_key`)).rows;
        let backend: number | undefined;
        // Wait for the real renewal UPDATE to block, so the socket dies in flight,
        // rather than on idle checkout (which already reconnects).
        await expect
          .poll(async () => {
            const { rows: waiting } = await observer.query<{ pid: number }>(
              `SELECT pid FROM pg_locks WHERE relation = $1::regclass AND NOT granted`,
              [table],
            );
            backend = waiting[0]?.pid;
            return backend;
          })
          .toBeTypeOf("number");
        await observer.query("SELECT pg_terminate_backend($1)", [backend]);
        if (replace) {
          await client.query(`UPDATE ${table} SET owner = 'successor' WHERE lease_key = 'first'`);
          await client.query(`UPDATE ${table} SET expires_at = 0 WHERE lease_key = 'second'`);
        }
        await client.query("COMMIT");
        if (replace) {
          await expect
            .poll(() => lost.map((callback) => callback.mock.calls.length))
            .toEqual([1, 1]);
          expect(lost[0]!.mock.calls[0]?.[0]).toMatchObject({ loss: { reason: "replaced" } });
          expect(lost[1]!.mock.calls[0]?.[0]).toMatchObject({ loss: { reason: "expired" } });
          const after = await rows();
          expect(after[0].owner).toBe("successor");
          expect(Number(after[1].expires_at)).toBe(0);
          expect(after.map((row) => row.heartbeat_at)).toEqual(
            before.map((row) => row.heartbeat_at),
          );
        } else {
          await expect
            .poll(async () => {
              const after = await rows();
              return after.every(
                (row, index) => Number(row.heartbeat_at) > Number(before[index].heartbeat_at),
              );
            })
            .toBe(true);
          expect(lost.map((callback) => callback.mock.calls)).toEqual([[], []]);
          for (const heartbeat of heartbeats) {
            await expect(heartbeat.verify()).resolves.toBeGreaterThan(Date.now());
            await expect(heartbeat.renew()).resolves.toBeGreaterThan(Date.now());
          }
        }
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        await Promise.all(heartbeats.map((heartbeat) => heartbeat.stop()));
        await closeOpenClawStateDatabaseAsync();
        await observer.end();
        await cleanupPostgresStateFixture(client, pathname, namespace);
      }
    },
  );
});
