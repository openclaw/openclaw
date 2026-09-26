import { once } from "node:events";
import type { Worker, WorkerOptions } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { withOpenClawStateLease, type OpenClawStateLeaseContext } from "./openclaw-state-lease.js";

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

  it("acknowledges ownership checks while the parent holds a state write transaction", async () => {
    await withOpenClawTestState({ label: "maintenance-lease-transaction" }, async (state) => {
      // This control checks liveness during a transaction, not the one-second
      // expiry boundary. Allow a cold worker to start under parallel checking.
      await withOpenClawStateLease({ ...options(state.env), leaseMs: 10_000 }, async (lease) => {
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            lease.assertOwnedInTransaction(db);
            block(450);
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

  it("does not enter maintenance when its heartbeat exits before readiness", async () => {
    await withOpenClawTestState({ label: "maintenance-lease-startup-loss" }, async (state) => {
      const terminate = (worker: Worker) => {
        void worker.terminate();
      };
      heartbeatWorkers.onCreate = terminate;
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

  it.each(["return", "throw", "abort"] as const)(
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
        if (ending === "return") {
          await expect(operation).resolves.toBe("completed");
        } else {
          await expect(operation).rejects.toThrow(
            ending === "throw" ? "operation failed" : "was aborted",
          );
        }
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
