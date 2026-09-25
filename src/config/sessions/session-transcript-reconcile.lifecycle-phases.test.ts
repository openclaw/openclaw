import { execFile } from "node:child_process";
import { once } from "node:events";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as admissionServices from "../../infra/sqlite-transaction.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import * as preparationOwner from "../../infra/sqlite-worker-lifecycle-preparation.js";
import * as coordinatorOwner from "../../infra/state-database-coordinator.js";
import {
  acquireStateDatabaseCoordinator,
  resolveStateDatabaseCoordinatorPath,
} from "../../infra/state-database-coordinator.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import {
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "../../state/openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withSqliteWorkerLifecycleCoordination } from "./session-accessor.sqlite-worker-coordination.js";
import { observeReconcileHostSqlite } from "./session-transcript-reconcile.sql-observer.test-support.js";
import type {
  SessionTranscriptReconcileWorkerTask,
  SessionTranscriptReconcileWorkerMessage,
} from "./session-transcript-reconcile.worker.js";

type Pool = WorkerTaskPool<SessionTranscriptReconcileWorkerTask, void>;
function createPool(failCoordinatorClose = false): Pool {
  return new WorkerTaskPool<SessionTranscriptReconcileWorkerTask, void>({
    workerUrl: failCoordinatorClose
      ? new URL("./session-transcript-reconcile.close-failure.test-support.mjs", import.meta.url)
      : resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionTranscriptReconcile),
    ...(failCoordinatorClose
      ? { workerOptions: { workerData: { sourceLoaderUrl: import.meta.resolve("tsx/esm/api") } } }
      : {}),
    maxWorkers: 1,
    maxPendingTasks: 4,
  });
}

async function releaseInRealWorker(
  pool: Pool,
  context: OpenClawStateWorkerContext,
  leaseId: string,
  agentPath: string,
  afterDispatch?: () => void,
  disk?: {
    agentId: string;
    observe(message: SessionTranscriptReconcileWorkerMessage, port: MessagePort): void;
  },
) {
  const { port1, port2 } = new MessageChannel();
  const closed = once(port1, "close");
  const messages: unknown[] = [];
  port1.on("message", (message: SessionTranscriptReconcileWorkerMessage) => {
    messages.push(message);
    disk?.observe(message, port1);
  });
  const controller = new AbortController();
  let pending: Promise<void> | undefined;
  try {
    await withSqliteWorkerLifecycleCoordination(
      context,
      `transcript:${disk ? "disk" : "release"}:${leaseId}`,
      async (coordination) => {
        pending = pool.run(
          {
            input: {
              ...(disk
                ? { mode: "disk" as const, agentId: disk.agentId }
                : { mode: "release" as const }),
              path: agentPath,
              stateDir: context.environment.OPENCLAW_STATE_DIR,
              externallySupervised: true,
              leaseId,
            },
            coordination,
            sourceIdentity: disk ? readDatabasePathIdentitySync(agentPath).key : undefined,
            port: port2,
          },
          {
            inputBytes: 512,
            signal: controller.signal,
            transferList: (task) => [
              task.port,
              ...(task.coordination?.stateLifecycle ? [task.coordination.stateLifecycle] : []),
              ...(task.coordination?.reconciliation
                ? [task.coordination.reconciliation.open, task.coordination.reconciliation.close]
                : []),
            ],
          },
        );
        afterDispatch?.();
        await pending;
        await closed;
      },
      async () => {
        controller.abort();
        await pending?.catch(() => {});
        port2.close();
        await closed;
      },
      "reconciliation",
    );
    return messages;
  } finally {
    port1.close();
    port2.close();
  }
}

function observe(context: OpenClawStateWorkerContext) {
  return observeReconcileHostSqlite({
    control: [
      resolveStateDatabaseCoordinatorPath({
        databasePath: context.admission.databasePath,
        runtimeDirectory: context.coordinatorRuntime.directory,
        uid: process.getuid?.(),
      }),
    ],
    data: [context.admission.databasePath],
  });
}

it("counts all eight boundaries, including pre-attached cached statements and unknown databases", () => {
  const sqlite = requireNodeSqlite();
  const existing = new sqlite.DatabaseSync(":memory:");
  const cached = existing.prepare("SELECT 1 AS value");
  const observation = observeReconcileHostSqlite({ control: [], data: [] });
  try {
    const database = new sqlite.DatabaseSync(":memory:");
    database.exec("CREATE TABLE data (value INTEGER)");
    database.prepare("INSERT INTO data VALUES (1)").run();
    database.prepare("SELECT value FROM data").get();
    database.prepare("SELECT value FROM data").all();
    expect([...database.prepare("SELECT value FROM data").iterate()]).toEqual([{ value: 1 }]);
    database.close();
    expect(Object.values(observation.counts()).every((count) => count > 0)).toBe(true);
    expect(observation.calls.every((call) => call.bucket === "unknown")).toBe(true);
    observation.calls.length = 0;
    expect(cached.get()).toEqual({ value: 1 });
    expect(observation.calls).toEqual([
      expect.objectContaining({ method: "get", bucket: "unknown" }),
    ]);
  } finally {
    observation.restore();
    existing.close();
  }
});

describe("reconciliation cleanup transport native custody", () => {
  it.each([false, true])(
    "keeps cold/warm cleanup and drain off the host, borrowed=%s",
    async (borrowed) => {
      await withOpenClawTestState(
        { scenario: "external-service", label: "reconcile-native-phases" },
        async (state) => {
          const leases = ["cold", "warm"].map((name) => {
            const path = state.path(name, "agent.sqlite");
            return {
              path,
              leaseId: claimOpenClawAgentDatabaseLease({ agentId: name, path }),
            };
          });
          closeOpenClawStateDatabaseForTest();
          const context = captureOpenClawStateWorkerContext();
          const parent = borrowed
            ? acquireStateDatabaseCoordinator({ databasePath: context.admission.databasePath })
            : undefined;
          const pool = createPool();
          const observation = observe(context);
          try {
            for (const lease of leases) {
              await expect(
                releaseInRealWorker(pool, context, lease.leaseId, lease.path),
              ).resolves.toEqual([{ type: "lease-released" }]);
            }
            expect(pool.getSnapshot().workersCreated).toBe(1);
            await pool.close();
            expect(observation.calls).toEqual([]);
            expect(Object.values(observation.counts())).toEqual(Array(8).fill(0));
          } finally {
            await pool.close();
            observation.restore();
            parent?.release();
          }
          expect(
            openOpenClawStateDatabase()
              .db.prepare("SELECT count(*) AS count FROM agent_database_leases")
              .get(),
          ).toEqual({ count: 0 });
        },
      );
    },
  );

  it.each(["before-native", "after-native"] as const)(
    "refuses %s admission and joins retirement",
    async (refusalStage) => {
      await withOpenClawTestState(
        { scenario: "external-service", label: "reconcile-revoked-phase" },
        async (state) => {
          const lease = claimOpenClawAgentDatabaseLease({
            agentId: "main",
            path: state.path("main", "agent.sqlite"),
          });
          closeOpenClawStateDatabaseForTest();
          const original = captureOpenClawStateWorkerContext();
          let revoked = false;
          const context: OpenClawStateWorkerContext = {
            ...original,
            admission: {
              ...original.admission,
              assertCurrent() {
                original.admission.assertCurrent();
                if (revoked) {
                  throw new Error("Synthetic original authority revoked");
                }
              },
            },
          };
          const pool = createPool();
          const prepare = preparationOwner.createSqliteWorkerLifecyclePreparation;
          let reachedNativeAdmission = false;
          const preparations = vi
            .spyOn(preparationOwner, "createSqliteWorkerLifecyclePreparation")
            .mockImplementation((params) =>
              prepare({
                ...params,
                admit() {
                  reachedNativeAdmission = true;
                  if (refusalStage === "after-native") {
                    throw new Error("Synthetic acquired native phase refused");
                  }
                  return params.admit();
                },
              }),
            );
          const observation = observe(context);
          try {
            await expect(
              releaseInRealWorker(pool, context, lease, state.path("main", "agent.sqlite"), () => {
                revoked = refusalStage === "before-native";
              }),
            ).rejects.toThrow();
            await pool.close();
            expect(observation.calls).toEqual([]);
            expect(reachedNativeAdmission).toBe(refusalStage === "after-native");
          } finally {
            await pool.close();
            observation.restore();
            preparations.mockRestore();
          }
          expect(
            openOpenClawStateDatabase()
              .db.prepare("SELECT lease_id FROM agent_database_leases WHERE lease_id = ?")
              .get(lease),
          ).toEqual({ lease_id: lease });
        },
      );
    },
  );
});

it.each(["exclude", "schema", "version"] as const)(
  "retains physical custody across the phase yield against foreign %s",
  async (operation) => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "reconcile-phase-yield" },
      async (state) => {
        const options = { agentId: "main", path: state.path("agent", "agent.sqlite") };
        openOpenClawAgentDatabase(options);
        closeOpenClawAgentDatabaseByPath(options.path);
        closeOpenClawStateDatabaseForTest();
        const context = captureOpenClawStateWorkerContext();
        const pool = createPool();
        const ready = createDeferred<MessagePort>();
        const leaseId = `phase-yield-${operation}`;
        const observation = observe(context);
        let parent: MessagePort | undefined;
        let completed = false;
        const task = releaseInRealWorker(pool, context, leaseId, options.path, undefined, {
          agentId: options.agentId,
          observe(message, port) {
            if (message.type === "done") {
              ready.resolve(port);
            } else if (
              ["plan-start", "active-chunk", "fts-chunk", "plan-finish"].includes(message.type)
            ) {
              port.postMessage({ type: "continue", accepted: true });
            }
          },
        });
        void task.catch(() => {});
        try {
          parent = await Promise.race([
            ready.promise,
            task.then(() => {
              throw new Error("Reconciliation settled before the phase-yield witness");
            }),
          ]);
          const child = await promisify(execFile)(process.execPath, [
            fileURLToPath(
              new URL(
                "./session-transcript-reconcile.foreign-owner.test-support.mjs",
                import.meta.url,
              ),
            ),
            JSON.stringify({
              operation,
              statePath: context.admission.databasePath,
              agentPath: options.path,
              runtime: context.coordinatorRuntime,
              environment: context.environment,
              sourceLoaderUrl: import.meta.resolve("tsx/esm/api"),
            }),
          ]);
          const verdict: unknown = JSON.parse(child.stdout);
          if (operation === "exclude") {
            // The short lifecycle lock is available; the retained native handle still prevents publication.
            expect(verdict).toMatchObject({
              acquired: false,
              family: "state-handles",
              agentCleanupRefused: true,
            });
          } else if (operation === "version") {
            expect(verdict).toEqual({ changed: true, unchangedSchemaCookie: true });
          } else {
            expect(verdict).toEqual({ changed: true });
          }
          parent.postMessage({ type: "release" }, []);
          if (operation === "exclude") {
            await expect(task).resolves.toContainEqual({ type: "lease-released" });
          } else {
            await expect(task).rejects.toThrow();
          }
          completed = true;
          await pool.close();
          expect(observation.calls).toEqual([]);
        } finally {
          if (!completed) {
            parent?.postMessage({ type: "release" }, []);
          }
          await task.catch(() => {});
          await pool.close();
          observation.restore();
        }
        const lease = openOpenClawStateDatabase()
          .db.prepare("SELECT lease_id FROM agent_database_leases WHERE lease_id = ?")
          .get(leaseId);
        if (operation !== "exclude") {
          expect(lease).toEqual({ lease_id: leaseId });
          releaseOpenClawAgentDatabaseLease(leaseId);
        } else {
          expect(lease).toBeUndefined();
        }
      },
    );
  },
);

it("borrows custody acquired after dispatch without adding host SQL beyond that explicit owner", async () => {
  await withOpenClawTestState(
    { scenario: "external-service", label: "reconcile-late-parent" },
    async (state) => {
      const lease = claimOpenClawAgentDatabaseLease({
        agentId: "main",
        path: state.path("main", "agent.sqlite"),
      });
      closeOpenClawStateDatabaseForTest();
      const context = captureOpenClawStateWorkerContext();
      const pool = createPool();
      const observation = observe(context);
      let parent: ReturnType<typeof acquireStateDatabaseCoordinator> | undefined;
      let injected: typeof observation.calls = [];
      try {
        await expect(
          releaseInRealWorker(pool, context, lease, state.path("main", "agent.sqlite"), () => {
            const offset = observation.calls.length;
            parent = acquireStateDatabaseCoordinator({
              databasePath: context.admission.databasePath,
            });
            injected = observation.calls.slice(offset);
          }),
        ).resolves.toEqual([{ type: "lease-released" }]);
        await pool.close();
        expect(injected.some((call) => call.method === "exec")).toBe(true);
        // All eight boundaries stay visible; only this fixture's actual acquisition is expected.
        expect(observation.calls).toEqual(injected);
        expect(observation.calls.every((call) => call.bucket === "control")).toBe(true);
      } finally {
        await pool.close();
        observation.restore();
        parent?.release();
      }
    },
  );
});

it("joins native exit after failed coordinator close without replaying completed lease deletion", async () => {
  await withOpenClawTestState(
    { scenario: "external-service", label: "reconcile-close-failure" },
    async (state) => {
      const lease = claimOpenClawAgentDatabaseLease({
        agentId: "main",
        path: state.path("main", "agent.sqlite"),
      });
      closeOpenClawStateDatabaseForTest();
      const context = captureOpenClawStateWorkerContext();
      const pool = createPool(true);
      const observation = observe(context);
      try {
        await expect(
          releaseInRealWorker(pool, context, lease, state.path("main", "agent.sqlite")),
        ).rejects.toThrow();
        await pool.close();
        expect(pool.getSnapshot().workers).toBe(0);
        expect(observation.calls).toEqual([]);
      } finally {
        await pool.close();
        observation.restore();
      }
      expect(
        openOpenClawStateDatabase()
          .db.prepare("SELECT lease_id FROM agent_database_leases WHERE lease_id = ?")
          .get(lease),
      ).toBeUndefined();
    },
  );
});

it.each(["phase", "service"] as const)(
  "settles every borrowed delegate after %s cleanup fails",
  async (failureSite) => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "reconcile-finish-failure" },
      async (state) => {
        const lease = claimOpenClawAgentDatabaseLease({
          agentId: "main",
          path: state.path("main", "agent.sqlite"),
        });
        closeOpenClawStateDatabaseForTest();
        const context = captureOpenClawStateWorkerContext();
        const pool = createPool();
        const delegates: NonNullable<
          ReturnType<typeof coordinatorOwner.tryCreateStateLifecycleDelegate>
        >[] = [];
        const created = coordinatorOwner.tryCreateStateLifecycleDelegate;
        const createDelegate = vi
          .spyOn(coordinatorOwner, "tryCreateStateLifecycleDelegate")
          .mockImplementation((params) => {
            const delegate = created(params);
            if (delegate) {
              delegates.push(delegate);
            }
            return delegate;
          });
        const fault = new Error(`Synthetic ${failureSite} cleanup failure`);
        let fail = true;
        const finish = preparationOwner.createSqliteWorkerLifecyclePreparation;
        const preparations = vi
          .spyOn(preparationOwner, "createSqliteWorkerLifecyclePreparation")
          .mockImplementation((params) => {
            const preparation = finish(params);
            return {
              ...preparation,
              finish() {
                preparation.finish();
                if (failureSite === "phase" && fail) {
                  fail = false;
                  throw fault;
                }
              },
            };
          });
        const retainService = admissionServices.retainSqliteWriteAdmissionService;
        const serviceReleases: Array<() => void> = [];
        const services = vi
          .spyOn(admissionServices, "retainSqliteWriteAdmissionService")
          .mockImplementation((...args) => {
            const release = retainService(...args);
            serviceReleases.push(release);
            return () => {
              release();
              if (failureSite === "service" && fail) {
                fail = false;
                throw fault;
              }
            };
          });
        const warnings = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
        let parent: ReturnType<typeof acquireStateDatabaseCoordinator> | undefined;
        try {
          await expect(
            releaseInRealWorker(pool, context, lease, state.path("main", "agent.sqlite"), () => {
              parent = acquireStateDatabaseCoordinator({
                databasePath: context.admission.databasePath,
              });
            }),
          ).resolves.toEqual([{ type: "lease-released" }]);
          await pool.close();
          expect(fail).toBe(false);
          expect(delegates.length).toBeGreaterThan(0);
          expect(delegates.every((delegate) => delegate.closed)).toBe(true);
          expect(warnings).toHaveBeenCalledWith(expect.objectContaining({ cause: fault }));
          expect(
            admissionServices.sqliteWriteAdmissionServicesForLocation(
              resolveStateDatabaseCoordinatorPath({
                databasePath: context.admission.databasePath,
                runtimeDirectory: context.coordinatorRuntime.directory,
                uid: process.getuid?.(),
              }),
            ),
          ).toBeUndefined();
        } finally {
          await pool.close();
          warnings.mockRestore();
          services.mockRestore();
          preparations.mockRestore();
          createDelegate.mockRestore();
          serviceReleases.forEach((release) => release());
          delegates.forEach((delegate) => delegate.release());
          parent?.release();
        }
      },
    );
  },
);

it.each([
  { borrowed: false, replacement: false },
  { borrowed: true, replacement: false },
  { borrowed: false, replacement: true },
])(
  "settles interphase state drainage with borrowed=$borrowed, replacement=$replacement",
  async ({ borrowed, replacement }) => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "reconcile-interphase-drain" },
      async (state) => {
        const options = { agentId: "main", path: state.path("agent", "agent.sqlite") };
        openOpenClawAgentDatabase(options);
        closeOpenClawAgentDatabaseByPath(options.path);
        closeOpenClawStateDatabaseForTest();
        const context = captureOpenClawStateWorkerContext();
        const identity = context.admission.identity.key;
        const parent = borrowed
          ? acquireStateDatabaseCoordinator({ databasePath: context.admission.databasePath })
          : undefined;
        const pool = createPool();
        const ready = createDeferred<MessagePort>();
        const leaseId = `interphase-drain-${borrowed}-${replacement}`;
        const retainedPath = `${context.admission.databasePath}.retained`;
        let replaced = false;
        const task = releaseInRealWorker(pool, context, leaseId, options.path, undefined, {
          agentId: options.agentId,
          observe(message, port) {
            if (message.type === "done") {
              ready.resolve(port);
            } else if (
              ["plan-start", "active-chunk", "fts-chunk", "plan-finish"].includes(message.type)
            ) {
              port.postMessage({ type: "continue", accepted: true });
            }
          },
        });
        void task.catch(() => {});
        let releasePort: MessagePort | undefined;
        try {
          releasePort = await Promise.race([
            ready.promise,
            task.then(() => {
              throw new Error("Reconciliation settled before the interphase drainage witness");
            }),
          ]);
          await closeOpenClawStateDatabaseByPathAsync(context.admission.databasePath);
          expect(readDatabasePathIdentitySync(context.admission.databasePath).key).toBe(identity);
          expect(() => context.admission.assertCurrent()).toThrow();
          if (replacement) {
            renameSync(context.admission.databasePath, retainedPath);
            replaced = true;
            writeFileSync(context.admission.databasePath, "replacement must not be opened");
          }
          releasePort.postMessage({ type: "release" }, []);
          if (replacement) {
            await expect(task).rejects.toThrow();
            expect(readFileSync(context.admission.databasePath, "utf8")).toBe(
              "replacement must not be opened",
            );
            return;
          }
          await expect(task).resolves.toContainEqual({ type: "lease-released" });
          expect(
            openOpenClawStateDatabase()
              .db.prepare("SELECT lease_id FROM agent_database_leases WHERE lease_id = ?")
              .get(leaseId),
          ).toBeUndefined();
        } finally {
          releasePort?.postMessage({ type: "release" }, []);
          await task.catch(() => {});
          await pool.close();
          parent?.release();
          if (replaced) {
            rmSync(context.admission.databasePath);
            renameSync(retainedPath, context.admission.databasePath);
          }
          releaseOpenClawAgentDatabaseLease(leaseId);
        }
      },
    );
  },
);
