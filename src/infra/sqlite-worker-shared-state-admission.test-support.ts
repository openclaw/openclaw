import { once } from "node:events";
import type { DatabaseSync } from "node:sqlite";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import type { NativeHookRelayBridgeRecord } from "../agents/harness/native-hook-relay-bridge-record.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerOperations } from "../state/openclaw-state-worker-contract.js";
import {
  executeOpenClawStateWorker,
  runOpenClawStateWorkerOperation,
} from "../state/openclaw-state-worker-store.js";
import { storeDeviceAuthTokenInDatabase } from "./device-auth-store.kernel.js";
import * as nodeSqlite from "./node-sqlite.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import type { SqliteWorkerRequest } from "./sqlite-worker-contract.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import {
  openSharedStateSqliteWorkerStore,
  runSqliteWorkerStoreOperation,
} from "./sqlite-worker-store.js";
import {
  acquireStateDatabaseCoordinator,
  acquireGatewayLifecycleCoordinator,
  resolveStateDatabaseCoordinatorPath,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "./state-database-coordinator.js";

export function registerSharedStateWorkerAdmissionTests(
  createContext: () => OpenClawStateWorkerContext,
): void {
  it("services direct broker commit admission while a native writer waits for lifecycle custody", async () => {
    const captured = createContext();
    await executeOpenClawStateWorker(captured, { type: "deviceAuth.prepare", input: undefined });
    const store = await openSharedStateSqliteWorkerStore<OpenClawStateWorkerOperations>(
      {
        moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sharedStateStore),
        databasePath: captured.admission.databasePath,
      },
      captured,
    );
    if (!store) {
      throw new Error("Expected the prepared shared-state worker");
    }
    const stages: string[] = [];
    let nativeFailure: unknown;
    const workerInput = {
      deviceId: "synthetic-broker-worker",
      role: "operator",
      token: "synthetic-worker-token",
    };
    const nativeInput = { ...workerInput, deviceId: "synthetic-broker-native" };
    try {
      await runSqliteWorkerStoreOperation(
        store,
        (scope) => scope.execute({ type: "deviceAuth.store", input: workerInput }),
        captured,
        () => captured.admission.assertCurrent(),
        () => ({
          nativeLocations: [captured.admission.databasePath],
          admission: createSqliteWorkerOperationAdmission((request, grant) => {
            stages.push(request.stage);
            expect(grant()).toBe(true);
            if (request.stage === "transaction") {
              // The worker owns the real lifecycle lock and next needs its commit grant.
              try {
                withStateDatabaseCoordinatorRuntimeDirectory(captured.coordinatorRuntime, () =>
                  runOpenClawStateWriteTransaction(
                    ({ db }) => storeDeviceAuthTokenInDatabase(db, nativeInput),
                    { path: captured.admission.databasePath, env: captured.environment },
                  ),
                );
              } catch (error) {
                nativeFailure = error;
              }
            }
          }),
        }),
      );
      expect(nativeFailure).toBeUndefined();
      expect(stages).toEqual(["transaction", "commit"]);
      for (const input of [workerInput, nativeInput]) {
        expect(
          await store.execute({
            type: "deviceAuth.read",
            input: {
              deviceId: input.deviceId,
              role: input.role,
              readOnly: true,
            },
          }),
        ).toMatchObject({
          entry: { token: input.token, role: input.role },
        });
      }
    } finally {
      await store.close();
    }
  });

  it.each(
    [undefined, false].flatMap((requireStateLifecycle) =>
      (["before-dispatch", "after-dispatch"] as const).map((timing) => ({
        requireStateLifecycle,
        timing,
      })),
    ),
  )(
    "borrows parent lifecycle custody acquired $timing for nested native admission (explicit=$requireStateLifecycle)",
    async ({ requireStateLifecycle, timing }) => {
      const captured = createContext();
      const worker = await prepareSharedStateWorker(captured);
      const record: NativeHookRelayBridgeRecord = {
        relayId: "synthetic-admission-relay",
        pid: 100,
        hostname: "127.0.0.1",
        port: 18789,
        token: "synthetic-test-token",
        expiresAtMs: 20000,
      };
      const acquireParent = () =>
        withStateDatabaseCoordinatorRuntimeDirectory(captured.coordinatorRuntime, () =>
          acquireStateDatabaseCoordinator({
            databasePath: captured.admission.databasePath,
            busyTimeoutMs: 0,
          }),
        );
      let parent = timing === "before-dispatch" ? acquireParent() : undefined;
      const post = worker.postMessage.bind(worker);
      const posts = vi.spyOn(worker, "postMessage").mockImplementation((request, ...args) => {
        if (timing === "after-dispatch" && request.type === "execute" && !parent) {
          // The broker already chose worker acquisition; maintenance claims custody before delivery.
          expect(request.workerStateLifecycle).toBeDefined();
          parent = acquireParent();
        }
        return post(request, ...args);
      });
      let grants = 0;
      try {
        await runOpenClawStateWorkerOperation(
          captured,
          (scope) =>
            scope.execute({ type: "nativeHookRelay.write", input: { record, updatedAtMs: 1 } }),
          {
            requireStateLifecycle,
            createAdmission: () => ({
              nativeLocations: [captured.admission.databasePath],
              admission: createSqliteWorkerOperationAdmission((request, grant) => {
                expect(request.stage).toBe("transaction");
                // The worker already holds its write transaction and awaits this grant.
                // An independent native acquisition must borrow the same physical owner.
                const nested = withStateDatabaseCoordinatorRuntimeDirectory(
                  captured.coordinatorRuntime,
                  () =>
                    acquireStateDatabaseCoordinator({
                      databasePath: captured.admission.databasePath,
                      busyTimeoutMs: 0,
                    }),
                );
                nested.release();
                captured.admission.assertCurrent();
                expect(grant()).toBe(true);
                grants += 1;
              }),
            }),
          },
        );
      } finally {
        posts.mockRestore();
        parent?.release();
      }
      expect(grants).toBe(1);
      expect(
        await executeOpenClawStateWorker(captured, {
          type: "nativeHookRelay.read",
          input: { relayId: record.relayId },
        }),
      ).toEqual(record);
    },
  );

  it("fences explicitly requested worker execution without a host grant factory", async () => {
    const captured = createContext();
    await executeOpenClawStateWorker(captured, {
      type: "flows.list",
      input: { ownerKey: "agent:main:main" },
    });
    const foreign = await holdForeignLifecycle(captured);
    let checks = 0;
    let completed = false;
    const result = runOpenClawStateWorkerOperation(
      captured,
      (scope) => scope.execute({ type: "flows.list", input: { ownerKey: "agent:main:main" } }),
      {
        requireStateLifecycle: true,
        assertCurrent: () => {
          checks += 1;
        },
      },
    ).then((value) => {
      completed = true;
      return value;
    });
    try {
      await vi.waitFor(() => expect(checks).toBeGreaterThan(4));
      expect(completed).toBe(false);
      foreign.release();
      await expect(result).resolves.toEqual([]);
    } finally {
      await foreign.close();
      await result;
    }
  });

  it("waits for a bounded foreign lifecycle owner before an admitted write", async () => {
    const captured = createContext();
    await executeOpenClawStateWorker(captured, {
      type: "flows.list",
      input: { ownerKey: "agent:main:main" },
    });
    const foreign = await holdForeignLifecycle(captured, 250);
    try {
      foreign.release();
      const record: NativeHookRelayBridgeRecord = {
        relayId: "foreign-owner-relay",
        pid: 100,
        hostname: "127.0.0.1",
        port: 18789,
        token: "synthetic-foreign-owner-token",
        expiresAtMs: 20000,
      };
      await runOpenClawStateWorkerOperation(
        captured,
        (scope) =>
          scope.execute({
            type: "nativeHookRelay.write",
            input: { record, updatedAtMs: 1 },
          }),
        {
          createAdmission: () => ({
            nativeLocations: [captured.admission.databasePath],
            admission: createSqliteWorkerOperationAdmission((request, grant) => {
              expect(request.stage).toBe("transaction");
              captured.admission.assertCurrent();
              expect(grant()).toBe(true);
            }),
          }),
        },
      );
      expect(
        await executeOpenClawStateWorker(captured, {
          type: "nativeHookRelay.read",
          input: { relayId: record.relayId },
        }),
      ).toEqual(record);
    } finally {
      await foreign.close();
    }
  });

  it.each(["abort", "revoke", "exit"] as const)(
    "settles pre-dispatch %s while the foreign lifecycle owner remains held",
    async (stop) => {
      const captured = createContext();
      const posts = vi.spyOn(Worker.prototype, "postMessage");
      await executeOpenClawStateWorker(captured, {
        type: "flows.list",
        input: { ownerKey: "agent:main:main" },
      });
      const worker = posts.mock.contexts[0];
      if (!(worker instanceof Worker)) {
        throw new Error("Expected the shared-state worker");
      }
      posts.mockClear();
      const foreign = await holdForeignLifecycle(captured);
      const canceled = new AbortController();
      const stopped = new Error("synthetic caller stopped");
      let current = true;
      const createAdmission = vi.fn(() => ({
        nativeLocations: [captured.admission.databasePath],
        admission: createSqliteWorkerOperationAdmission((_request, grant) => grant()),
      }));
      try {
        await runOpenClawStateWorkerOperation(
          captured,
          async (scope) => {
            const pending = scope.execute(
              { type: "nativeHookRelay.write", input: { record: relayRecord(1), updatedAtMs: 1 } },
              { signal: canceled.signal },
            );
            const result = pending.then(
              () => ({ error: undefined }),
              (error: unknown) => ({ error }),
            );
            if (stop === "abort") {
              canceled.abort(stopped);
            } else if (stop === "revoke") {
              current = false;
            } else {
              await worker.terminate();
            }
            // The foreign owner is still held; settlement must not wait for its five-second budget.
            let settled = false;
            void result.then(() => {
              settled = true;
            });
            await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1000 });
            const { error } = await result;
            if (stop === "exit") {
              expect(error).toMatchObject({ code: "unavailable" });
            } else {
              expect(error).toBe(stopped);
            }
          },
          {
            createAdmission,
            assertCurrent: () => {
              if (!current) {
                throw stopped;
              }
            },
          },
        );
        expect(createAdmission).not.toHaveBeenCalled();
        expect(posts.mock.calls.some(([request]) => request.operationAdmission !== undefined)).toBe(
          false,
        );
      } finally {
        posts.mockRestore();
        await foreign.close();
        if (stop === "exit") {
          // Join the canonical owner's failed-actor retirement even when an assertion fails.
          await Promise.allSettled([
            executeOpenClawStateWorker(captured, {
              type: "nativeHookRelay.read",
              input: { relayId: "queued-lifecycle-relay" },
            }),
          ]);
        }
      }
      expect(
        await executeOpenClawStateWorker(captured, {
          type: "nativeHookRelay.read",
          input: { relayId: "queued-lifecycle-relay" },
        }),
      ).toBeUndefined();
    },
  );

  it.each(
    (["after-acquire", "admission-factory", "cleanup-failure"] as const).flatMap((timing) =>
      [...([false, true] as const), ...(timing === "after-acquire" ? [] : (["late"] as const))].map(
        (parentHeld) => ({ timing, parentHeld }),
      ),
    ),
  )(
    "settles a canceled head and its follower at $timing before native execution (parent held: $parentHeld)",
    async ({ timing, parentHeld }) => {
      const captured = createContext();
      const worker = await prepareSharedStateWorker(captured);
      const nativeOpen = nodeSqlite.openNodeSqliteDatabase;
      const opened = new Map<string, DatabaseSync>();
      const openSpy = vi
        .spyOn(nodeSqlite, "openNodeSqliteDatabase")
        .mockImplementation((location, ...options) => {
          const database = nativeOpen(location, ...options);
          opened.set(location, database);
          return database;
        });
      const gateway = withStateDatabaseCoordinatorRuntimeDirectory(
        captured.coordinatorRuntime,
        () => acquireGatewayLifecycleCoordinator({ databasePath: captured.admission.databasePath }),
      );
      openSpy.mockRestore();
      const native = opened.get(gateway.path);
      if (!native) {
        gateway.release();
        throw new Error("Expected the native Gateway coordinator");
      }
      const acquireParent = () =>
        withStateDatabaseCoordinatorRuntimeDirectory(captured.coordinatorRuntime, () =>
          acquireStateDatabaseCoordinator({
            databasePath: captured.admission.databasePath,
            busyTimeoutMs: 0,
          }),
        );
      let parent = parentHeld === true ? acquireParent() : undefined;
      const canceled = new AbortController();
      const stopped = new Error("synthetic cancellation before post");
      let factories = 0;
      let closeAttempts = 0;
      const closeFailure = new Error("synthetic unposted fence close failed");
      const close = native.close.bind(native);
      const closes = vi.spyOn(native, "close").mockImplementation(() => {
        if (timing === "cleanup-failure" && ++closeAttempts === 1) {
          throw closeFailure;
        }
        return close();
      });
      const post = worker.postMessage.bind(worker);
      const posts = vi.spyOn(worker, "postMessage").mockImplementation((request, ...args) => {
        if (parentHeld === "late" && request.type === "execute" && !parent) {
          expect(request.workerStateLifecycle).toBeDefined();
          parent = acquireParent();
        }
        return post(request, ...args);
      });
      try {
        await runOpenClawStateWorkerOperation(
          captured,
          async (scope) => {
            const head = scope.execute(
              {
                type: "nativeHookRelay.write",
                input: { record: relayRecord(0), updatedAtMs: 1 },
              },
              { signal: canceled.signal },
            );
            const follower = scope.execute({
              type: "nativeHookRelay.write",
              input: { record: relayRecord(1), updatedAtMs: 2 },
            });
            if (timing === "after-acquire") {
              canceled.abort(stopped);
            }
            const [first, second] = await Promise.allSettled([head, follower]);
            if (timing === "cleanup-failure") {
              expect(first).toMatchObject({
                status: "rejected",
                reason: { cause: stopped, errors: [stopped, { cause: closeFailure }] },
              });
              expect(second).toMatchObject({ status: "rejected", reason: { code: "unavailable" } });
              expect(closeAttempts).toBe(2);
            } else {
              expect(first).toEqual({ status: "rejected", reason: stopped });
              expect(second.status).toBe("fulfilled");
            }
          },
          {
            createAdmission: () => {
              factories += 1;
              if (timing !== "after-acquire" && factories === 1) {
                if (timing === "cleanup-failure") {
                  gateway.release();
                }
                canceled.abort(stopped);
              }
              return {
                nativeLocations: [captured.admission.databasePath],
                admission: createSqliteWorkerOperationAdmission((request, grant) => {
                  expect(request.stage).toBe("transaction");
                  captured.admission.assertCurrent();
                  expect(grant()).toBe(true);
                }),
              };
            },
          },
        );
        const writes = posts.mock.calls.filter(([request]) => request.type === "execute");
        expect(factories).toBe(
          timing === "after-acquire" ? 1 : timing === "cleanup-failure" ? 1 : 2,
        );
        if (timing === "cleanup-failure") {
          return;
        }
        expect(writes.some(([request]) => request.gatewaySchemaFence !== undefined)).toBe(true);
        expect(
          await executeOpenClawStateWorker(captured, {
            type: "nativeHookRelay.read",
            input: { relayId: "queued-lifecycle-relay" },
          }),
        ).toEqual(relayRecord(1));
      } finally {
        posts.mockRestore();
        // Both the original failure and the recovered actor remain under canonical drain.
        await Promise.allSettled([closeOpenClawStateDatabaseAsync()]);
        try {
          gateway.release();
        } finally {
          closes.mockRestore();
          try {
            gateway.release();
          } finally {
            parent?.release();
          }
        }
      }
    },
  );

  it("retains FIFO and bounded capacity when canceling a lifecycle waiter", async () => {
    const captured = createContext();
    await executeOpenClawStateWorker(captured, {
      type: "flows.list",
      input: { ownerKey: "agent:main:main" },
    });
    const foreign = await holdForeignLifecycle(captured);
    const canceled = new AbortController();
    const stopped = new Error("synthetic head canceled");
    const dispatched: number[] = [];
    // oxlint-disable-next-line typescript/unbound-method -- call restores the sending worker below.
    const originalPost = Worker.prototype.postMessage;
    const posts = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
      this: Worker,
      request: SqliteWorkerRequest,
      transferList,
    ) {
      // Record command facts before the private wire buffer is detached by transfer.
      if (request.type === "execute") {
        const command = deserialize(request.input) as {
          type: string;
          input: { record: NativeHookRelayBridgeRecord };
        };
        if (command.type === "nativeHookRelay.write" && command.input.record.pid !== 0) {
          dispatched.push(command.input.record.pid);
        }
      }
      return originalPost.call(this, request, transferList);
    });
    let factories = 0;
    try {
      await runOpenClawStateWorkerOperation(
        captured,
        async (scope) => {
          const write = (index: number, signal?: AbortSignal) =>
            scope.execute(
              {
                type: "nativeHookRelay.write",
                input: { record: relayRecord(index), updatedAtMs: index },
              },
              { signal },
            );
          const cancelOverflow = async () => {
            const controller = new AbortController();
            const waiting = write(999, controller.signal);
            const settled = vi.fn();
            void waiting.then(settled, settled);
            await Promise.resolve();
            expect(settled).not.toHaveBeenCalled();
            controller.abort(stopped);
            await expect(waiting).rejects.toBe(stopped);
          };
          const head = write(0, canceled.signal);
          const headOutcome = head.then(
            () => undefined,
            (error: unknown) => error,
          );
          const followers = Array.from({ length: 127 }, (_, index) => write(index + 1));
          const settledFollowers = Promise.allSettled(followers);
          await cancelOverflow();
          expect(factories).toBe(0);
          const replacement = write(128);
          const replacementOutcome = Promise.allSettled([replacement]);
          canceled.abort(stopped);
          expect(await headOutcome).toBe(stopped);
          await cancelOverflow();
          foreign.release();
          for (const result of [...(await settledFollowers), ...(await replacementOutcome)]) {
            expect(result.status).toBe("fulfilled");
          }
          // A full second burst proves that drainage returned exactly the retained credits.
          const nextBurst = Promise.allSettled(
            Array.from({ length: 128 }, (_, index) => write(index + 129)),
          );
          await cancelOverflow();
          for (const result of await nextBurst) {
            expect(result.status).toBe("fulfilled");
          }
        },
        {
          createAdmission: () => {
            factories += 1;
            return {
              nativeLocations: [captured.admission.databasePath],
              admission: createSqliteWorkerOperationAdmission((request, grant) => {
                expect(request.stage).toBe("transaction");
                captured.admission.assertCurrent();
                expect(grant()).toBe(true);
              }),
            };
          },
        },
      );
      expect(dispatched).toEqual(Array.from({ length: 256 }, (_, index) => index + 1));
      expect(factories).toBe(256);
      expect(
        await executeOpenClawStateWorker(captured, {
          type: "nativeHookRelay.read",
          input: { relayId: "queued-lifecycle-relay" },
        }),
      ).toEqual(relayRecord(256));
    } finally {
      posts.mockRestore();
      await foreign.close();
    }
  });
}

async function prepareSharedStateWorker(captured: OpenClawStateWorkerContext): Promise<Worker> {
  const posts = vi.spyOn(Worker.prototype, "postMessage");
  try {
    await executeOpenClawStateWorker(captured, { type: "deviceAuth.prepare", input: undefined });
    const worker = posts.mock.contexts[0];
    if (!(worker instanceof Worker)) {
      throw new Error("Expected the prepared shared-state worker");
    }
    return worker;
  } finally {
    posts.mockRestore();
  }
}

function relayRecord(pid: number): NativeHookRelayBridgeRecord {
  return {
    relayId: "queued-lifecycle-relay",
    pid,
    hostname: "127.0.0.1",
    port: 18789,
    token: "synthetic-queued-token",
    expiresAtMs: 20000,
  };
}

export async function holdForeignLifecycle(captured: OpenClawStateWorkerContext, delayMs = 0) {
  const coordinatorPath = resolveStateDatabaseCoordinatorPath({
    databasePath: captured.admission.databasePath,
    runtimeDirectory: captured.coordinatorRuntime.directory,
    uid: process.getuid?.(),
  });
  const worker = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const database = new DatabaseSync(workerData.path);
    database.exec("BEGIN EXCLUSIVE");
    parentPort.once("message", () => setTimeout(() => {
      database.exec("ROLLBACK");
      database.close();
      parentPort.close();
    }, workerData.delayMs));
    parentPort.postMessage("held");
  `,
    { eval: true, execArgv: [], env: {}, workerData: { path: coordinatorPath, delayMs } },
  );
  const exited = once(worker, "exit");
  try {
    expect(await once(worker, "message")).toEqual(["held"]);
  } catch (error) {
    await worker.terminate();
    throw error;
  }
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      worker.postMessage("release", []);
    }
  };
  return {
    release,
    close: async () => {
      release();
      await exited;
    },
  };
}
