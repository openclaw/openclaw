import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { beginDoctorMaintenance } from "../../commands/doctor-maintenance.js";
import * as coordinator from "../../infra/state-database-coordinator.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
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

describe("SQLite mutation worker coordinator custody", () => {
  it("drains retained lifecycle custody after the close owner revokes new reads", async () => {
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

  it("admits another agent lease while a sibling worker retains lifecycle custody", async () => {
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
              worker.postMessage(
                coordination,
                coordination.stateLifecycle ? [coordination.stateLifecycle] : [],
              );
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
          await holding;
          await Promise.all(workers.map((worker) => worker.terminate()));
        }
      },
    );
  });

  it("joins native worker exit before rejecting delegate preparation", async () => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "mutation-worker-preparation" },
      async () => {
        openOpenClawStateDatabase();
        const context = captureOpenClawStateWorkerContext();
        const worker = createWaitingWorker();
        const failure = new Error("Synthetic lifecycle delegate preparation failure");
        const prepare = vi
          .spyOn(coordinator, "tryCreateStateLifecycleDelegate")
          .mockImplementationOnce(() => {
            throw failure;
          });
        try {
          await once(worker, "online");
          await expect(
            withSqliteMutationWorkerCoordination(
              context,
              { kind: "dedicated", channel: worker },
              1,
              async () => {
                throw new Error("Worker request dispatched after preparation failed");
              },
            ),
          ).rejects.toBe(failure);
          expect(worker.threadId).toBe(-1);
        } finally {
          prepare.mockRestore();
          await worker.terminate();
        }
      },
    );
  });

  it("preserves a completed result and drains its failed release through the captured Doctor owner", async () => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "mutation-worker-release" },
      async (state) => {
        await coordinator.withStateDatabaseCoordinatorRuntimeDirectory(
          state.path("coordinator-runtime"),
          async () => {
            const maintenance = await beginDoctorMaintenance({
              options: { repair: true, nonInteractive: true },
              root: null,
              runtime: { log() {}, error() {}, exit() {} },
            });
            const receipt: {
              delegate?: ReturnType<typeof coordinator.tryCreateStateLifecycleDelegate>;
            } = {};
            try {
              try {
                await maintenance!.run(async () => {
                  openOpenClawStateDatabase();
                  const context = captureOpenClawStateWorkerContext();
                  const worker = createWaitingWorker();
                  const createDelegate = coordinator.tryCreateStateLifecycleDelegate;
                  let failRelease = true;
                  const prepare = vi
                    .spyOn(coordinator, "tryCreateStateLifecycleDelegate")
                    .mockImplementation((params) => {
                      const delegate = createDelegate(params);
                      if (!delegate) {
                        return delegate;
                      }
                      receipt.delegate = delegate;
                      return {
                        get port() {
                          return delegate.port;
                        },
                        get closed() {
                          return delegate.closed;
                        },
                        release() {
                          if (failRelease) {
                            failRelease = false;
                            throw new Error("Synthetic retained coordinator release failure");
                          }
                          delegate.release();
                        },
                      };
                    });
                  try {
                    await expect(
                      coordinator.withStateDatabaseCoordinatorRuntimeDirectory(
                        state.path("unrelated-runtime"),
                        () =>
                          withSqliteMutationWorkerCoordination(
                            context,
                            { kind: "dedicated", channel: worker },
                            1,
                            async () => {
                              const completed = Promise.all([
                                once(worker, "message"),
                                once(worker, "exit"),
                              ]);
                              worker.postMessage("mutation completed", []);
                              const [[result], [exitCode]] = await completed;
                              expect(exitCode).toBe(0);
                              return result;
                            },
                          ),
                      ),
                    ).resolves.toBe("mutation completed");
                    expect(worker.threadId).toBe(-1);
                    expect(receipt.delegate?.closed).toBe(false);
                  } finally {
                    prepare.mockRestore();
                    await worker.terminate();
                  }
                });
              } finally {
                await maintenance?.release();
              }
              expect(receipt.delegate?.closed).toBe(true);
            } finally {
              receipt.delegate?.release();
            }
          },
        );
      },
    );
  });
});
