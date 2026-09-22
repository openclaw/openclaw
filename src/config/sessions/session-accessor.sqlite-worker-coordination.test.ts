import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { beginDoctorMaintenance } from "../../commands/doctor-maintenance.js";
import * as coordinator from "../../infra/state-database-coordinator.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withSqliteMutationWorkerCoordination } from "./session-accessor.sqlite-worker-coordination.js";

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
            withSqliteMutationWorkerCoordination(context, worker, 1, async () => {
              throw new Error("Worker request dispatched after preparation failed");
            }),
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
                          withSqliteMutationWorkerCoordination(context, worker, 1, async () => {
                            const completed = Promise.all([
                              once(worker, "message"),
                              once(worker, "exit"),
                            ]);
                            worker.postMessage("mutation completed", []);
                            const [[result], [exitCode]] = await completed;
                            expect(exitCode).toBe(0);
                            return result;
                          }),
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
