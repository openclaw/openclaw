import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { createSqliteDatabaseAdmissionRelay } from "../../infra/sqlite-worker-operation-admission.js";
import { recordOpenClawDatabaseQuarantine } from "../../state/openclaw-quarantine-store.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  withSqliteMutationWorkerCoordination,
  withSqliteWorkerLifecycleCoordination,
} from "./session-accessor.sqlite-worker-coordination.js";

function createWaitingWorker() {
  return new Worker(
    `const { parentPort } = require("node:worker_threads");
     parentPort.once("message", (result) => {
       parentPort.postMessage(result);
       parentPort.close();
     });`,
    { eval: true, execArgv: [] },
  );
}

describe("SQLite mutation worker ownership", () => {
  it("admits a host profile write while reconciliation publishes a cold quarantine fact", async () => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "reconcile-cold-quarantine" },
      async (state) => {
        openOpenClawStateDatabase();
        recordOpenClawDatabaseQuarantine({
          path: state.path("unrelated.sqlite"),
          kind: "agent",
          reason: "synthetic unrelated damage",
        });
        const context = captureOpenClawStateWorkerContext();
        const release = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
        // Task workers also have a general metadata relay. The lifecycle channel
        // must win when a synchronous host write needs to service the lock holder.
        const fallback = createSqliteDatabaseAdmissionRelay(() => {});
        const worker = new Worker(
          new URL(
            "./session-accessor.sqlite-worker-coordination.worker.test-support.mjs",
            import.meta.url,
          ),
          {
            execArgv: [],
            workerData: {
              operation: "cold-quarantine",
              release: release.buffer,
              agentPath: state.path("cold.sqlite"),
              sourceLoaderUrl: import.meta.resolve("tsx/esm/api"),
            },
          },
        );
        try {
          await withSqliteWorkerLifecycleCoordination(
            context,
            "cold-quarantine",
            async (coordination) => {
              const held = once(worker, "message");
              const exited = once(worker, "exit");
              worker.postMessage({ ...coordination, fallbackAdmission: fallback.port }, [
                fallback.port,
                ...(coordination.databaseAdmission ? [coordination.databaseAdmission] : []),
              ]);
              expect(await held).toEqual(["held"]);
              const finished = once(worker, "message");
              Atomics.store(release, 0, 1);
              Atomics.notify(release, 0);
              const profile = ensureProfileForEmail("concurrent@example.test");
              expect(
                openOpenClawStateDatabase()
                  .db.prepare("SELECT profile_id FROM user_profile_emails WHERE email = ?")
                  .get("concurrent@example.test"),
              ).toEqual({ profile_id: profile.id });
              expect(await finished).toEqual(["checked"]);
              expect(await exited).toEqual([0]);
            },
            async () => {
              await worker.terminate();
            },
            "reconciliation",
          );
        } finally {
          Atomics.store(release, 0, 1);
          Atomics.notify(release, 0);
          await worker.terminate();
          fallback.finish();
        }
      },
    );
  });

  it("allows accepted cleanup after the close owner revokes new reads", async () => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "mutation-worker-retained-close" },
      async () => {
        openOpenClawStateDatabase();
        const context = captureOpenClawStateWorkerContext();
        const close = vi.fn(async () => "closed");
        let attempted = false;
        const unregister = registerOpenClawStateDatabaseAsyncResource({
          close: async () => {
            // A failed assertion must not strand the test's own close resource.
            if (attempted) {
              return;
            }
            attempted = true;
            expect(() => context.admission.assertCurrent()).toThrow(/read admission is closed/);
            await expect(
              withSqliteWorkerLifecycleCoordination(
                context,
                "retained-close",
                close,
                async () => {},
              ),
            ).resolves.toBe("closed");
          },
        });
        try {
          await closeOpenClawStateDatabaseByPathAsync(context.admission.databasePath);
          expect(close).toHaveBeenCalledOnce();
        } finally {
          unregister();
        }
      },
    );
  });

  it("admits another agent lease while a sibling worker retains process ownership", async () => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "mutation-worker-parallel-leases" },
      async (state) => {
        openOpenClawStateDatabase();
        const context = captureOpenClawStateWorkerContext();
        const release = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
        const createWorker = (operation: "hold" | "lease") =>
          new Worker(
            new URL(
              "./session-accessor.sqlite-worker-coordination.worker.test-support.mjs",
              import.meta.url,
            ),
            {
              execArgv: [],
              workerData: {
                operation,
                release: release.buffer,
                agentPath: state.path(operation, "openclaw-agent.sqlite"),
                sourceLoaderUrl: import.meta.resolve("tsx/esm/api"),
              },
            },
          );
        const holder = createWorker("hold");
        const claimant = createWorker("lease");
        const workers = [holder, claimant];
        const dispatch = (worker: Worker, result: "held" | "claimed") =>
          withSqliteMutationWorkerCoordination(
            context,
            { kind: "dedicated", channel: worker },
            1,
            async (coordination) => {
              const completed = Promise.all([once(worker, "message"), once(worker, "exit")]);
              worker.postMessage(coordination, []);
              const [response, exited] = await completed;
              expect(response).toEqual([result]);
              expect(exited).toEqual([0]);
            },
          );
        const held = once(holder, "message");
        const holding = dispatch(holder, "held");
        try {
          expect(await held).toEqual(["held"]);
          await dispatch(claimant, "claimed");
          expect(
            openOpenClawStateDatabase()
              .db.prepare("SELECT count(*) AS count FROM agent_database_leases")
              .get(),
          ).toEqual({ count: 0 });
        } finally {
          Atomics.store(release, 0, 1);
          Atomics.notify(release, 0);
          try {
            await holding;
          } finally {
            await Promise.all(workers.map((worker) => worker.terminate()));
          }
        }
      },
    );
  });

  it("joins native worker exit before rejecting failed dispatch", async () => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "mutation-worker-preparation" },
      async () => {
        openOpenClawStateDatabase();
        const context = captureOpenClawStateWorkerContext();
        const worker = createWaitingWorker();
        const failure = new Error("Synthetic worker dispatch failure");
        try {
          await once(worker, "online");
          await expect(
            withSqliteMutationWorkerCoordination(
              context,
              { kind: "dedicated", channel: worker },
              1,
              async () => {
                throw failure;
              },
            ),
          ).rejects.toBe(failure);
          expect(worker.threadId).toBe(-1);
        } finally {
          await worker.terminate();
        }
      },
    );
  });
});
