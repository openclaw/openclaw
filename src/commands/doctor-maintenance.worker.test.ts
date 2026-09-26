import fs from "node:fs/promises";
import { MessagePort } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeHookRelayBridgeRecord } from "../agents/harness/native-hook-relay-store.js";
import { captureCoordinatorDatabase } from "../infra/sqlite-coordinator.test-support.js";
import * as coordinatorDelegate from "../infra/state-database-coordinator-delegate.js";
import * as stateCoordinator from "../infra/state-database-coordinator.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

function relayRecord(revision: number): NativeHookRelayBridgeRecord {
  return {
    relayId: "doctor",
    pid: revision,
    hostname: "127.0.0.1",
    port: 18789,
    token: "synthetic-doctor-worker-token",
    expiresAtMs: 20000,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
});

describe("Doctor maintenance with shared-state workers", () => {
  it.each([false, true])(
    "preserves pooling until worker close requests retirement (close before owner release=%s)",
    async (closeBeforeRelease) => {
      await withOpenClawTestState(
        { scenario: "external-service", label: "doctor-worker-retention" },
        async (state) => {
          const directory = state.path("coordinator-runtime");
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
                    type: "plugins.conversationBindingApprovals.read",
                    input: undefined,
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
          let execute = executeOpenClawStateWorker;
          let capture = captureOpenClawStateWorkerContext;
          if (alreadyOpen) {
            await execute(capture(), {
              type: "nativeHookRelay.read",
              input: { relayId: "doctor" },
            });
          }
          let enterMaintenance = beginDoctorMaintenance;
          if (reload) {
            await closeOpenClawStateDatabaseAsync();
            vi.resetModules();
            const [doctor, worker, contexts] = await Promise.all([
              import("./doctor-maintenance.js"),
              import("../state/openclaw-state-worker-store.js"),
              import("../state/openclaw-state-worker-context.js"),
            ]);
            enterMaintenance = doctor.beginDoctorMaintenance;
            execute = worker.executeOpenClawStateWorker;
            capture = contexts.captureOpenClawStateWorkerContext;
          }
          const maintenance = await enterMaintenance({
            options: { repair: true, nonInteractive: true },
            root: null,
            runtime: { log() {}, error() {}, exit() {} },
          });
          const record = relayRecord(1);
          try {
            await maintenance!.run(async () => {
              await execute(capture(), {
                type: "nativeHookRelay.write",
                input: { record, updatedAtMs: 1 },
              });
              expect(
                await execute(capture(), {
                  type: "nativeHookRelay.read",
                  input: { relayId: record.relayId },
                }),
              ).toEqual(record);
            });
          } finally {
            await maintenance?.release();
          }
          await closeOpenClawStateDatabaseAsync();
          expect(
            await execute(capture(), {
              type: "nativeHookRelay.read",
              input: { relayId: record.relayId },
            }),
          ).toEqual(record);
          const successor = relayRecord(2);
          await execute(capture(), {
            type: "nativeHookRelay.write",
            input: { record: successor, updatedAtMs: 2 },
          });
          expect(
            await execute(capture(), {
              type: "nativeHookRelay.read",
              input: { relayId: record.relayId },
            }),
          ).toEqual(successor);
        },
      );
    },
  );

  it("preserves a committed write receipt when its retained coordinator release fails", async () => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "doctor-managed-cleanup" },
      async () => {
        openOpenClawStateDatabase();
        const maintenance = await beginDoctorMaintenance({
          options: { repair: true, nonInteractive: true },
          root: null,
          runtime: { log() {}, error() {}, exit() {} },
        });
        const context = captureOpenClawStateWorkerContext();
        const receipt: {
          delegate?: ReturnType<typeof stateCoordinator.tryCreateStateLifecycleDelegate>;
        } = {};
        try {
          await maintenance!.run(async () => {
            await executeOpenClawStateWorker(context, {
              type: "nativeHookRelay.read",
              input: { relayId: "doctor" },
            });
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
            const created = relayRecord(1);
            try {
              await executeOpenClawStateWorker(context, {
                type: "nativeHookRelay.write",
                input: { record: created, updatedAtMs: 1 },
              });
            } finally {
              spy.mockRestore();
            }
            await closeOpenClawStateDatabaseAsync();
            expect(receipt.delegate?.closed).toBe(true);
            expect(
              await executeOpenClawStateWorker(context, {
                type: "nativeHookRelay.read",
                input: { relayId: "doctor" },
              }),
            ).toEqual(created);
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
          const context = captureOpenClawStateWorkerContext();
          if (beforeMaintenance) {
            await executeOpenClawStateWorker(context, {
              type: "nativeHookRelay.read",
              input: { relayId: "doctor" },
            });
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
                await executeOpenClawStateWorker(context, {
                  type: "nativeHookRelay.read",
                  input: { relayId: "doctor" },
                });
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
                  executeOpenClawStateWorker(context, {
                    type: "nativeHookRelay.write",
                    input: { record: relayRecord(1), updatedAtMs: 1 },
                  }),
                ).rejects.toThrow("Synthetic delegate setup failure");
              } finally {
                send.mockRestore();
                delegate.mockRestore();
              }
              await closeOpenClawStateDatabaseAsync();
              expect(receipt.retained?.closed).toBe(true);
              expect(
                await executeOpenClawStateWorker(context, {
                  type: "nativeHookRelay.read",
                  input: { relayId: "doctor" },
                }),
              ).toBeUndefined();
              const created = relayRecord(2);
              await executeOpenClawStateWorker(context, {
                type: "nativeHookRelay.write",
                input: { record: created, updatedAtMs: 2 },
              });
              await closeOpenClawStateDatabaseAsync();
              expect(
                await executeOpenClawStateWorker(context, {
                  type: "nativeHookRelay.read",
                  input: { relayId: "doctor" },
                }),
              ).toEqual(created);
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
