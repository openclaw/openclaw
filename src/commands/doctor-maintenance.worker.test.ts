import fs from "node:fs/promises";
import path from "node:path";
import { MessagePort } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeIdleSqliteCoordinators } from "../infra/sqlite-coordinator.js";
import { captureCoordinatorDatabase } from "../infra/sqlite-coordinator.test-support.js";
import * as coordinatorDelegate from "../infra/state-database-coordinator-delegate.js";
import * as stateCoordinator from "../infra/state-database-coordinator.js";
import type { ManagedTaskFlowRecord } from "../plugins/runtime/runtime-taskflow.types.js";
import { createRuntimeAsyncTasks } from "../plugins/runtime/runtime-tasks-async.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../state/openclaw-state-worker-store.js";
import { resetTaskFlowRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  resetTaskFlowRegistryForTests({ persist: false });
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Doctor maintenance with managed-flow workers", () => {
  it.each([false, true])(
    "preserves pooling until worker close requests retirement (close before owner release=%s)",
    async (closeBeforeRelease) => {
      // Runner-owned databases intentionally close instead of pooling. Exercise
      // production retention in a unique external state/runtime, then retire it.
      const runtime = stateCoordinator.resolveStateLifecycleRuntimeDirectory();
      await fs.mkdir(runtime, { recursive: true });
      const root = tempDirs.make("doctor-worker-retention-", await fs.realpath(runtime));
      await withOpenClawTestState(
        {
          scenario: "external-service",
          label: "doctor-worker-retention",
          env: { OPENCLAW_STATE_DIR: path.join(root, "state") },
        },
        async () => {
          const directory = path.join(root, "coordinator-runtime");
          await stateCoordinator.withStateDatabaseCoordinatorRuntimeDirectory(
            { directory, keepAlive: true },
            async () => {
              const context = captureOpenClawStateWorkerContext();
              // The pool only retains an already-established coordinator file.
              stateCoordinator
                .acquireStateDatabaseCoordinator({ databasePath: context.admission.databasePath })
                .release();
              const { result: coordinator, database } = captureCoordinatorDatabase(() =>
                stateCoordinator.acquireStateDatabaseCoordinator({
                  databasePath: context.admission.databasePath,
                }),
              );
              try {
                expect(
                  await executeOpenClawStateWorker(context, {
                    type: "tasks.list",
                    input: { ownerKey: "agent:main:doctor" },
                  }),
                ).toEqual([]);
                if (closeBeforeRelease) {
                  await closeOpenClawStateDatabaseAsync();
                }
                coordinator.release();
                expect(database.isOpen).toBe(!closeBeforeRelease);
              } finally {
                await closeOpenClawStateDatabaseAsync();
                coordinator.release();
                stateCoordinator
                  .acquireStateDatabaseCoordinator({
                    databasePath: context.admission.databasePath,
                    keepAlive: false,
                  })
                  .release();
                closeIdleSqliteCoordinators(root);
              }
            },
          );
          await fs.rm(directory, { recursive: true });
        },
      );
    },
  );

  it.each([
    { alreadyOpen: false, reload: false },
    { alreadyOpen: true, reload: false },
    { alreadyOpen: true, reload: true },
  ])(
    "completes writes and drainage with an already-open worker=$alreadyOpen after module reload=$reload",
    async ({ alreadyOpen, reload }) => {
      await withOpenClawTestState(
        { scenario: "external-service", label: "doctor-managed-worker" },
        async () => {
          openOpenClawStateDatabase();
          let flows = createRuntimeAsyncTasks().managedFlows.bindSession({
            sessionKey: "agent:main:doctor",
          });
          if (alreadyOpen) {
            await flows.list();
          }
          let enterMaintenance = beginDoctorMaintenance;
          if (reload) {
            await closeOpenClawStateDatabaseAsync();
            vi.resetModules();
            const [reloadedDoctor, reloadedTasks] = await Promise.all([
              import("./doctor-maintenance.js"),
              import("../plugins/runtime/runtime-tasks-async.js"),
            ]);
            enterMaintenance = reloadedDoctor.beginDoctorMaintenance;
            flows = reloadedTasks.createRuntimeAsyncTasks().managedFlows.bindSession({
              sessionKey: "agent:main:doctor",
            });
          }
          const maintenance = await enterMaintenance({
            options: { repair: true, nonInteractive: true },
            root: null,
            runtime: { log() {}, error() {}, exit() {} },
          });
          let flowId: string;
          try {
            flowId = await maintenance!.run(async () => {
              const created = await flows.createManaged({
                controllerId: "tests/doctor",
                goal: "Complete Doctor repair",
              });
              const createdFlowId = created.flowId;
              expect(created.revision).toBe(0);
              await expect(
                flows.finish({
                  flowId: createdFlowId,
                  expectedRevision: created.revision,
                  stateJson: { completed: true },
                }),
              ).resolves.toMatchObject({
                applied: true,
                flow: { flowId: createdFlowId, status: "succeeded", revision: 1 },
              });
              return createdFlowId;
            });
          } finally {
            await maintenance?.release();
          }
          await closeOpenClawStateDatabaseAsync();
          expect(await flows.list()).toEqual([
            expect.objectContaining({
              flowId,
              goal: "Complete Doctor repair",
              status: "succeeded",
              revision: 1,
              stateJson: { completed: true },
            }),
          ]);
          const next = await flows.createManaged({
            controllerId: "tests/doctor",
            goal: "Continue after maintenance",
          });
          expect((await flows.list()).map((flow) => flow.flowId).toSorted()).toEqual(
            [flowId, next.flowId].toSorted(),
          );
        },
      );
    },
  );

  it("preserves a committed flow receipt when its retained coordinator release fails", async () => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "doctor-managed-cleanup" },
      async () => {
        openOpenClawStateDatabase();
        const maintenance = await beginDoctorMaintenance({
          options: { repair: true, nonInteractive: true },
          root: null,
          runtime: { log() {}, error() {}, exit() {} },
        });
        const flows = createRuntimeAsyncTasks().managedFlows.bindSession({
          sessionKey: "agent:main:doctor",
        });
        const receipt: {
          delegate?: ReturnType<typeof stateCoordinator.tryCreateStateLifecycleDelegate>;
        } = {};
        try {
          await maintenance!.run(async () => {
            await flows.list();
            const createDelegate = stateCoordinator.tryCreateStateLifecycleDelegate;
            let failRelease = true;
            const spy = vi
              .spyOn(stateCoordinator, "tryCreateStateLifecycleDelegate")
              .mockImplementation((params) => {
                const delegate = createDelegate(params);
                if (!delegate) {
                  return delegate;
                }
                receipt.delegate ??= delegate;
                return {
                  port: delegate.port,
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
            let created: ManagedTaskFlowRecord | null;
            try {
              created = await flows.tryCreateManaged({
                controllerId: "tests/doctor",
                goal: "Retain confirmed result",
              });
              expect(created).toMatchObject({ goal: "Retain confirmed result", revision: 0 });
            } finally {
              spy.mockRestore();
            }
            await closeOpenClawStateDatabaseAsync();
            expect(receipt.delegate?.closed).toBe(true);
            expect(await flows.list()).toEqual([created]);
          });
        } finally {
          receipt.delegate?.release();
          await maintenance?.release();
        }
      },
    );
  });

  it.each([false, true])(
    "retains cleanup after setup and first release fail (pre-maintenance worker=%s)",
    async (beforeMaintenance) => {
      await withOpenClawTestState(
        { scenario: "external-service", label: "doctor-managed-setup" },
        async () => {
          openOpenClawStateDatabase();
          const flows = createRuntimeAsyncTasks().managedFlows.bindSession({
            sessionKey: "agent:main:doctor",
          });
          if (beforeMaintenance) {
            await flows.list();
          }
          const maintenance = await beginDoctorMaintenance({
            options: { repair: true, nonInteractive: true },
            root: null,
            runtime: { log() {}, error() {}, exit() {} },
          });
          const receipt: {
            retained?: Parameters<typeof coordinatorDelegate.createCoordinatorDelegate>[2];
          } = {};
          try {
            await maintenance!.run(async () => {
              if (!beforeMaintenance) {
                await flows.list();
              }
              const create = coordinatorDelegate.createCoordinatorDelegate;
              let failRelease = true;
              const delegate = vi
                .spyOn(coordinatorDelegate, "createCoordinatorDelegate")
                .mockImplementation((identity, live, retained, revoke, label) => {
                  if (receipt.retained) {
                    return create(identity, live, retained, revoke, label);
                  }
                  receipt.retained = retained;
                  return create(
                    identity,
                    live,
                    {
                      get closed() {
                        return retained.closed;
                      },
                      release() {
                        if (failRelease) {
                          failRelease = false;
                          throw new Error("Synthetic retained release failure");
                        }
                        retained.release();
                      },
                    },
                    revoke,
                    label,
                  );
                });
              const send = vi
                .spyOn(MessagePort.prototype, "postMessage")
                .mockImplementationOnce(() => {
                  throw new Error("Synthetic delegate setup failure");
                });
              try {
                await expect(
                  flows.tryCreateManaged({
                    controllerId: "tests/doctor",
                    goal: "Undispatched repair",
                  }),
                ).resolves.toBeNull();
              } finally {
                send.mockRestore();
                delegate.mockRestore();
              }
              await closeOpenClawStateDatabaseAsync();
              expect(receipt.retained?.closed).toBe(true);
              expect(await flows.list()).toEqual([]);
              const created = await flows.createManaged({
                controllerId: "tests/doctor",
                goal: "Continue after setup failure",
              });
              await closeOpenClawStateDatabaseAsync();
              expect(await flows.list()).toEqual([created]);
            });
          } finally {
            receipt.retained?.release();
            await maintenance?.release();
          }
        },
      );
    },
  );
});
