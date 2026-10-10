import { once } from "node:events";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { resolveRuntimeWorkerThreadExecArgv } from "../infra/runtime-worker-url.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { holdStateDatabaseWriteTransaction } from "../test-utils/state-database-contention.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import {
  leaseHeartbeatState,
  type LeaseHeartbeatWorkerData,
} from "./openclaw-state-lease-heartbeat-shared.js";
import { acquireOpenClawStateLeaseInTransaction } from "./openclaw-state-lease-store.js";
import { runWithOpenClawStateLeaseWorker } from "./openclaw-state-lease-worker-operation.js";
import { withOpenClawStateLease, type OpenClawStateLeaseContext } from "./openclaw-state-lease.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

const heartbeatWorkers = vi.hoisted(() => ({
  beforeCreate: undefined as (() => void) | undefined,
  onCreate: undefined as ((worker: Worker) => void) | undefined,
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
        super(filename, workerOptions);
        if (String(filename) === heartbeatUrl.href) {
          heartbeatWorkers.onCreate?.(this);
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
  heartbeatWorkers.beforeCreate = undefined;
  heartbeatWorkers.onCreate = undefined;
  closeOpenClawStateDatabaseForTest();
});

describe("maintenance lease heartbeat", () => {
  it("preserves a native renewal error through the real worker and lease rejection", async () => {
    await withOpenClawTestState({ label: "maintenance-renewal-error" }, async (state) => {
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
  });

  it("does not enter maintenance after its lease expires while parent callbacks are blocked", async () => {
    await withOpenClawTestState({ label: "maintenance-child-open-expired" }, async (state) => {
      const { db } = openOpenClawStateDatabase({ env: state.env });
      const onWorker = () => {
        db.exec("BEGIN IMMEDIATE");
        try {
          block(1_200);
        } finally {
          db.exec("ROLLBACK");
        }
      };
      heartbeatWorkers.onCreate = onWorker;
      let entered = false;
      try {
        await expect(
          withOpenClawStateLease(options(state.env), async () => {
            entered = true;
          }),
        ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
        expect(entered).toBe(false);
        expect(readLease(state.env)).toBeUndefined();
      } finally {
        heartbeatWorkers.onCreate = undefined;
      }
    });
  });

  it("retains ownership while synchronous maintenance exceeds the lease duration", async () => {
    await withOpenClawTestState({ label: "maintenance-lease-blocked" }, async (state) => {
      await withOpenClawStateLease({ ...options(state.env), leaseMs: 10_000 }, async (lease) => {
        block(10_250);
        expect(() => lease.renew?.()).not.toThrow();
        expect(() => lease.assertOwned()).not.toThrow();
        expect(lease.signal.aborted).toBe(false);
      });
    });
  });

  it("renews through transient state contention before the maintenance lease expires", async () => {
    await withOpenClawTestState({ label: "maintenance-lease-contention" }, async (state) => {
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
  });

  it("acknowledges ownership checks while the parent holds a state write transaction", async () => {
    await withOpenClawTestState({ label: "maintenance-lease-transaction" }, async (state) => {
      await withOpenClawStateLease({ ...options(state.env), leaseMs: 1_500 }, async (lease) => {
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            lease.assertOwnedInTransaction(db);
            block(600);
            lease.assertOwnedInTransaction(db);
          },
          { env: state.env },
        );
      });
    });
  });

  it("rejects a terminated worker before its queued exit event reaches the parent", async () => {
    await withOpenClawTestState({ label: "maintenance-lease-worker-loss" }, async (state) => {
      const spawned = nextHeartbeatWorker();
      await expect(
        withOpenClawStateLease({ ...options(state.env), leaseMs: 10_000 }, async (lease) => {
          const worker = await spawned;
          void worker.terminate();
          block(100);
          expect(Number(readLease(state.env)?.expires_at)).toBeGreaterThan(Date.now());
          expect(() => lease.assertOwned()).toThrowError(
            expect.objectContaining({ code: "OPENCLAW_STATE_LEASE_LOST" }),
          );
          // The database alone still grants the old lease: only fresh worker
          // liveness can reject this assertion before the queued exit callback.
          expect(Number(readLease(state.env)?.expires_at)).toBeGreaterThan(Date.now());
        }),
      ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
      expect(readLease(state.env)).toBeUndefined();
    });
  });

  it("accepts published readiness when the parent notification is withheld", async () => {
    await withOpenClawTestState({ label: "maintenance-lease-delayed-ready" }, async (state) => {
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
  });

  it.each(["replacement", "expiry", "deletion"] as const)(
    "does not resurrect ownership after %s",
    async (failure) => {
      await withOpenClawTestState({ label: `maintenance-lease-${failure}` }, async (state) => {
        let changed: ReturnType<typeof readLease>;
        await expect(
          withOpenClawStateLease(options(state.env), async (lease) => {
            runOpenClawStateWriteTransaction(
              ({ db }) => {
                if (failure === "deletion") {
                  db.prepare("DELETE FROM state_leases WHERE scope = ?").run(
                    "core:test-maintenance",
                  );
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
            expect(() => lease.assertOwned()).toThrowError(
              expect.objectContaining({ code: "OPENCLAW_STATE_LEASE_LOST" }),
            );
            expect(readLease(state.env)).toEqual(changed);
          }),
        ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
        expect(readLease(state.env)).toEqual(failure === "replacement" ? changed : undefined);
      });
    },
  );

  it.each(["throw", "abort"] as const)(
    "stops renewal and retained callbacks when an operation ends by %s",
    async (ending) => {
      await withOpenClawTestState({ label: `maintenance-lease-${ending}` }, async (state) => {
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
      });
    },
  );
});

it("keeps deferred activation pending until renewal commits after contention", async () => {
  await withOpenClawTestState({ label: "lease-activation-contention" }, async (state) => {
    const database = openOpenClawStateDatabase({ env: state.env });
    const identity = { scope: "core:test", key: "activation", owner: "fixture-owner" };
    const acquired = runOpenClawStateWriteTransaction(
      ({ db }) => acquireOpenClawStateLeaseInTransaction(db, identity, 30_000),
      { database, env: state.env },
    );
    if (acquired.kind !== "acquired") {
      throw new Error("Fixture did not acquire its lease");
    }
    const shared = new BigInt64Array(
      new SharedArrayBuffer(
        (leaseHeartbeatState.startupPhase + 1) * BigInt64Array.BYTES_PER_ELEMENT,
      ),
    );
    Atomics.store(shared, leaseHeartbeatState.expiresAt, BigInt(acquired.expiresAt));
    const moduleUrl = pathToFileURL(
      path.resolve("src/state/openclaw-state-lease-heartbeat.worker.ts"),
    ).href;
    // Observe completion of the real activation handler without adding a production test hook.
    const driver = await state.writeText(
      "activation-worker.mts",
      `
      import { parentPort } from "node:worker_threads";
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
    const worker = new Worker(driverUrl, {
      workerData: {
        path: database.path,
        expectedIdentity: readDatabasePathIdentitySync(database.path).key,
        identity,
        leaseMs: 30_000,
        acquiredAt: acquired.expiresAt - 30_000,
        heartbeatMs: 250,
        deferActivation: true,
        shared: shared.buffer,
        renewalProgress: new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT),
        completedRequest: new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT),
      } satisfies LeaseHeartbeatWorkerData,
      execArgv: resolveRuntimeWorkerThreadExecArgv(driverUrl),
      env: {},
    });
    const prepared = createDeferredCore();
    const processed = createDeferredCore();
    const ready = createDeferredCore();
    const exited = createDeferredCore();
    let stopping = false;
    for (const pending of [prepared, processed, ready]) {
      void pending.promise.catch(() => {});
    }
    const fail = (error: unknown) => {
      prepared.reject(error);
      processed.reject(error);
      ready.reject(error);
    };
    worker.on("error", fail);
    worker.once("exit", () => {
      exited.resolve();
      if (!stopping) {
        fail(new Error("Heartbeat fixture exited before activation completed"));
      }
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
      await prepared.promise;
      writer.exec("BEGIN IMMEDIATE");
      worker.postMessage({ startup: "activate" }, []);
      await processed.promise;
      expect(Atomics.load(shared, leaseHeartbeatState.status)).toBe(leaseHeartbeatState.starting);
      writer.exec("ROLLBACK");
      await ready.promise;
      expect(Atomics.load(shared, leaseHeartbeatState.status)).toBe(leaseHeartbeatState.ready);
      const row = database.db
        .prepare("SELECT expires_at FROM state_leases WHERE scope = ? AND lease_key = ?")
        .get(identity.scope, identity.key);
      expect(row?.expires_at).toBe(Number(Atomics.load(shared, leaseHeartbeatState.expiresAt)));
      expect(Number(row?.expires_at)).toBeGreaterThan(acquired.expiresAt);
    } finally {
      if (writer.isTransaction) {
        writer.exec("ROLLBACK");
      }
      writer.close();
      stopping = true;
      await worker.terminate();
      await exited.promise;
    }
  });
});

it("admits heartbeat-owned worker writes without blocking the host and rolls back revoked commits", async () => {
  await withOpenClawTestState({ label: "native-lease-worker-write" }, async (state) => {
    const database = openOpenClawStateDatabase({ env: state.env });
    const context = captureOpenClawStateWorkerContext({ env: state.env });
    const storeKey = "native-heartbeat-grants";
    await withOpenClawStateLease(
      {
        scope: "core:mcp-oauth",
        key: storeKey,
        database: { scope: "shared", options: { env: state.env } },
        leaseMs: 60_000,
        waitMs: 0,
        heartbeat: "worker",
      },
      async (lease) => {
        const { StatementSync } = requireNodeSqlite();
        const hostCalls = [
          vi.spyOn(DatabaseSync.prototype, "prepare"),
          vi.spyOn(DatabaseSync.prototype, "exec"),
          vi.spyOn(StatementSync.prototype, "get"),
          vi.spyOn(StatementSync.prototype, "all"),
          vi.spyOn(StatementSync.prototype, "run"),
          vi.spyOn(StatementSync.prototype, "iterate"),
          vi.spyOn(Atomics, "wait"),
        ];
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
          for (const call of hostCalls) {
            expect(call).not.toHaveBeenCalled();
          }
        } finally {
          for (const call of hostCalls) {
            call.mockRestore();
          }
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
});
