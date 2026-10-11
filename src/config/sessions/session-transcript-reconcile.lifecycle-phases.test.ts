import { once } from "node:events";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
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
function createPool(failNativeCloseAt?: string): Pool {
  return new WorkerTaskPool<SessionTranscriptReconcileWorkerTask, void>({
    workerUrl: failNativeCloseAt
      ? new URL("./session-transcript-reconcile.close-failure.test-support.mjs", import.meta.url)
      : resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionTranscriptReconcile),
    ...(failNativeCloseAt
      ? {
          workerOptions: {
            workerData: {
              sourceLoaderUrl: import.meta.resolve("tsx/esm/api"),
              databasePath: failNativeCloseAt,
            },
          },
        }
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
                ? { mode: "disk" as const, agentId: disk.agentId, sessionIds: [] }
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
            transferList: (task) => [task.port],
          },
        );
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
    data: [context.admission.databasePath],
  });
}

it("counts all eight boundaries, including pre-attached cached statements and unknown databases", () => {
  const sqlite = requireNodeSqlite();
  const existing = new sqlite.DatabaseSync(":memory:");
  const cached = existing.prepare("SELECT 1 AS value");
  const observation = observeReconcileHostSqlite({ data: [] });
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
    "keeps cold/warm cleanup and drain off the host, serving Gateway owner=%s",
    async (owned) => {
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
          const parent = owned
            ? acquireGatewayStateOwner({
                databasePath: context.admission.databasePath,
                payload: {
                  pid: process.pid,
                  createdAt: new Date().toISOString(),
                  configPath: state.configPath,
                  stateDir: state.stateDir,
                  role: "gateway",
                },
              })
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
});

it("joins native exit when shared-state close fails after lease deletion", async () => {
  await withOpenClawTestState(
    { scenario: "external-service", label: "reconcile-close-failure" },
    async (state) => {
      const lease = claimOpenClawAgentDatabaseLease({
        agentId: "main",
        path: state.path("main", "agent.sqlite"),
      });
      closeOpenClawStateDatabaseForTest();
      const context = captureOpenClawStateWorkerContext();
      const pool = createPool(context.admission.databasePath);
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

it.each([false, true])(
  "settles interphase state drainage with serving Gateway owner=%s",
  async (owned) => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "reconcile-interphase-drain" },
      async (state) => {
        const options = { agentId: "main", path: state.path("agent", "agent.sqlite") };
        openOpenClawAgentDatabase(options);
        closeOpenClawAgentDatabaseByPath(options.path);
        closeOpenClawStateDatabaseForTest();
        const context = captureOpenClawStateWorkerContext();
        const identity = context.admission.identity.key;
        const parent = owned
          ? acquireGatewayStateOwner({
              databasePath: context.admission.databasePath,
              payload: {
                pid: process.pid,
                createdAt: new Date().toISOString(),
                configPath: state.configPath,
                stateDir: state.stateDir,
                role: "gateway",
              },
            })
          : undefined;
        const pool = createPool();
        const ready = createDeferred<MessagePort>();
        const leaseId = `interphase-drain-${owned}`;
        const task = releaseInRealWorker(pool, context, leaseId, options.path, {
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
          releasePort.postMessage({ type: "release" }, []);
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
          releaseOpenClawAgentDatabaseLease(leaseId);
        }
      },
    );
  },
);
