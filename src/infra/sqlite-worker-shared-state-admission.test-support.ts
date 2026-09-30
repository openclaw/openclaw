import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import type { NativeHookRelayBridgeRecord } from "../agents/harness/native-hook-relay-bridge-record.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerOperations } from "../state/openclaw-state-worker-contract.js";
import {
  executeOpenClawStateWorker,
  runOpenClawStateWorkerOperation,
} from "../state/openclaw-state-worker-store.js";
import {
  readDeviceAuthTokenObservationFromDatabase,
  storeDeviceAuthTokenInDatabase,
} from "./device-auth-store.kernel.js";
import { acquireGatewayStateOwner } from "./gateway-state-owner.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import {
  openSharedStateSqliteWorkerStore,
  runSqliteWorkerStoreOperation,
} from "./sqlite-worker-store.js";

export function registerSharedStateWorkerAdmissionTests(
  createContext: () => OpenClawStateWorkerContext,
): void {
  it("requires the exact live maintenance owner through the worker commit grant", async () => {
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
    const options = { path: captured.admission.databasePath, env: captured.environment };
    const database = openOpenClawStateDatabase(options);
    const owner = acquireGatewayStateOwner({ databasePath: database.path });
    const other = acquireGatewayStateOwner({
      databasePath: createContext().admission.databasePath,
    });
    const maintenance = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent: owner.assertCurrent,
      assertDatabaseAccess: owner.assertDatabaseAccess,
    });
    const wrongOwner = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent: other.assertCurrent,
      assertDatabaseAccess: other.assertDatabaseAccess,
    });
    const unbound = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent: owner.assertCurrent,
    });
    const stages: string[] = [];
    let lateOwner: ReturnType<typeof acquireGatewayStateOwner> | undefined;
    const write = (deviceId: string, beforeCommit?: () => void) =>
      runSqliteWorkerStoreOperation(
        store,
        (scope) =>
          scope.execute({
            type: "deviceAuth.store",
            input: { deviceId, role: "operator", token: "synthetic-owner-token" },
          }),
        captured,
        () => captured.admission.assertCurrent(),
        () => ({
          nativeLocations: [database.path],
          admission: createSqliteWorkerOperationAdmission((request, grant) => {
            stages.push(`${deviceId}:${request.stage}`);
            if (request.stage === "commit") {
              beforeCommit?.();
            }
            grant();
          }),
        }),
      );
    try {
      expect(() => openOpenClawStateDatabase(options)).toThrow("offline maintenance");
      expect(() =>
        runOpenClawStateWriteTransaction(
          ({ db }) =>
            storeDeviceAuthTokenInDatabase(db, {
              deviceId: "sync-unrelated",
              role: "operator",
              token: "must-not-commit",
            }),
          options,
        ),
      ).toThrow("offline maintenance");
      await expect(write("unrelated")).rejects.toThrow("offline maintenance");
      await expect(wrongOwner.run(() => write("wrong-owner"))).rejects.toThrow("does not own");
      await expect(unbound.run(() => write("unbound"))).rejects.toThrow("does not own");
      expect(stages).toEqual([]);
      await expect(maintenance.run(() => write("accepted"))).resolves.toMatchObject({
        token: "synthetic-owner-token",
      });
      await expect(maintenance.run(() => write("revoked", () => owner.release()))).rejects.toThrow(
        "no longer current",
      );
      await expect(
        write("late-maintenance", () => {
          lateOwner = acquireGatewayStateOwner({ databasePath: database.path });
        }),
      ).rejects.toThrow("offline maintenance");
      lateOwner?.release();
      expect(stages).toEqual([
        "accepted:transaction",
        "accepted:commit",
        "revoked:transaction",
        "revoked:commit",
        "late-maintenance:transaction",
        "late-maintenance:commit",
      ]);
      for (const deviceId of [
        "sync-unrelated",
        "unrelated",
        "wrong-owner",
        "unbound",
        "revoked",
        "late-maintenance",
      ]) {
        expect(
          readDeviceAuthTokenObservationFromDatabase(database.db, { deviceId, role: "operator" })
            .entry,
        ).toBeNull();
      }
      expect(
        readDeviceAuthTokenObservationFromDatabase(database.db, {
          deviceId: "accepted",
          role: "operator",
        }).entry?.token,
      ).toBe("synthetic-owner-token");
    } finally {
      lateOwner?.release();
      owner.release();
      other.release();
      await Promise.allSettled([maintenance.close(), wrongOwner.close(), unbound.close()]);
      await store.close();
    }
  });

  it("services direct broker commit admission while a native writer waits for its SQLite transaction", async () => {
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
              // The worker holds BEGIN IMMEDIATE and next needs its commit grant.
              try {
                runOpenClawStateWriteTransaction(
                  ({ db }) => storeDeviceAuthTokenInDatabase(db, nativeInput),
                  { path: captured.admission.databasePath, env: captured.environment },
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

  it.each(["abort", "revoke", "exit"] as const)(
    "settles a queued %s without mutating its rows behind a native writer",
    async (stop) => {
      const captured = createContext();
      const worker = await prepareSharedStateWorker(captured);
      const foreign = holdForeignWriter(captured);
      const canceled = new AbortController();
      const stopped = new Error("synthetic caller stopped");
      let current = true;
      const posts = vi.spyOn(worker, "postMessage");
      try {
        await runOpenClawStateWorkerOperation(
          captured,
          async (scope) => {
            const head = scope.execute({
              type: "nativeHookRelay.write",
              input: { record: relayRecord(0), updatedAtMs: 0 },
            });
            const headOutcome = Promise.allSettled([head]);
            const pending = scope.execute(
              { type: "nativeHookRelay.write", input: { record: relayRecord(1), updatedAtMs: 1 } },
              { signal: canceled.signal },
            );
            const outcome = pending.then(
              () => ({ error: undefined }),
              (error: unknown) => ({ error }),
            );
            try {
              if (stop === "abort") {
                canceled.abort(stopped);
              } else if (stop === "revoke") {
                current = false;
                foreign.release();
              } else {
                await worker.terminate();
              }
              const { error } = await outcome;
              if (stop === "exit") {
                expect(error).toMatchObject({ code: "unavailable" });
              } else {
                expect(error).toBe(stopped);
              }
              // Only the head reached the worker; the queued mutation never acquired authority.
              expect(
                posts.mock.calls.filter(([request]) => request.type === "execute"),
              ).toHaveLength(1);
            } finally {
              foreign.release();
              await headOutcome;
            }
          },
          {
            createAdmission: () => ({
              nativeLocations: [captured.admission.databasePath],
              admission: createSqliteWorkerOperationAdmission((_request, grant) => grant()),
            }),
            assertCurrent: () => {
              if (!current) {
                throw stopped;
              }
            },
          },
        );
      } finally {
        posts.mockRestore();
        foreign.close();
      }
      const stored = await executeOpenClawStateWorker(captured, {
        type: "nativeHookRelay.read",
        input: { relayId: "queued-writer-relay" },
      });
      expect(stored).toEqual(stop === "abort" ? relayRecord(0) : undefined);
    },
  );

  it("settles cancellation in the admission factory before posting and preserves its follower", async () => {
    const captured = createContext();
    await prepareSharedStateWorker(captured);
    const canceled = new AbortController();
    const stopped = new Error("synthetic cancellation before post");
    let factories = 0;
    await runOpenClawStateWorkerOperation(
      captured,
      async (scope) => {
        const head = scope.execute(
          {
            type: "nativeHookRelay.write",
            input: {
              record: { ...relayRecord(0), relayId: "canceled-before-post" },
              updatedAtMs: 0,
            },
          },
          { signal: canceled.signal },
        );
        const follower = scope.execute({
          type: "nativeHookRelay.write",
          input: { record: relayRecord(1), updatedAtMs: 1 },
        });
        const [first, second] = await Promise.allSettled([head, follower]);
        expect(first).toEqual({ status: "rejected", reason: stopped });
        expect(second.status).toBe("fulfilled");
      },
      {
        createAdmission: () => {
          if (++factories === 1) {
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
    expect(factories).toBe(2);
    expect(
      await executeOpenClawStateWorker(captured, {
        type: "nativeHookRelay.read",
        input: { relayId: "canceled-before-post" },
      }),
    ).toBeUndefined();
    expect(
      await executeOpenClawStateWorker(captured, {
        type: "nativeHookRelay.read",
        input: { relayId: "queued-writer-relay" },
      }),
    ).toEqual(relayRecord(1));
  });

  it("retains FIFO and bounded capacity when canceling a queued write behind a native writer", async () => {
    const captured = createContext();
    await prepareSharedStateWorker(captured);
    const foreign = holdForeignWriter(captured);
    const canceled = new AbortController();
    const stopped = new Error("synthetic queued write canceled");
    const posts = vi.spyOn(Worker.prototype, "postMessage");
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
          const head = write(0);
          const queued = write(1, canceled.signal);
          const canceledOutcome = queued.then(
            () => undefined,
            (error: unknown) => error,
          );
          const followers = Array.from({ length: 126 }, (_, index) => write(index + 2));
          const settledFollowers = Promise.allSettled([head, ...followers]);
          try {
            await cancelOverflow();
            expect(factories).toBe(1);
            const replacement = write(128);
            const replacementOutcome = Promise.allSettled([replacement]);
            canceled.abort(stopped);
            expect(await canceledOutcome).toBe(stopped);
            await cancelOverflow();
            foreign.release();
            for (const result of [...(await settledFollowers), ...(await replacementOutcome)]) {
              expect(result.status).toBe("fulfilled");
            }
            // A full second burst proves that drainage returned all retained credits.
            const nextBurst = Promise.allSettled(
              Array.from({ length: 128 }, (_, index) => write(index + 129)),
            );
            await cancelOverflow();
            for (const result of await nextBurst) {
              expect(result.status).toBe("fulfilled");
            }
          } finally {
            foreign.release();
            await settledFollowers;
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
      const dispatched = posts.mock.calls.flatMap(([request]) => {
        if (request.type !== "execute") {
          return [];
        }
        const command = deserialize(request.input) as {
          type: string;
          input: { record: NativeHookRelayBridgeRecord };
        };
        return command.type === "nativeHookRelay.write" ? [command.input.record.pid] : [];
      });
      expect(dispatched).toEqual([0, ...Array.from({ length: 255 }, (_, index) => index + 2)]);
      expect(factories).toBe(256);
      expect(
        await executeOpenClawStateWorker(captured, {
          type: "nativeHookRelay.read",
          input: { relayId: "queued-writer-relay" },
        }),
      ).toEqual(relayRecord(256));
    } finally {
      posts.mockRestore();
      foreign.close();
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
    relayId: "queued-writer-relay",
    pid,
    hostname: "127.0.0.1",
    port: 18789,
    token: "synthetic-queued-token",
    expiresAtMs: 20000,
  };
}

export function holdForeignWriter(captured: OpenClawStateWorkerContext) {
  const database = openNodeSqliteDatabase(captured.admission.databasePath);
  try {
    database.exec("BEGIN IMMEDIATE");
  } catch (error) {
    database.close();
    throw error;
  }
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      try {
        database.exec("ROLLBACK");
      } finally {
        database.close();
      }
    }
  };
  return { release, close: release };
}
