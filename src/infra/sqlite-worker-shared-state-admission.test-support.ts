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
import type { SqliteWorkerCommand, SqliteWorkerRequest } from "./sqlite-worker-contract.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import {
  openSharedStateSqliteWorkerStore,
  runSqliteWorkerStoreOperation,
} from "./sqlite-worker-store.js";

async function preparedStore(captured: OpenClawStateWorkerContext) {
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
  const run = (
    command: SqliteWorkerCommand<OpenClawStateWorkerOperations>,
    admit: Parameters<typeof createSqliteWorkerOperationAdmission>[0],
  ) =>
    runSqliteWorkerStoreOperation(
      store,
      (scope) => scope.execute(command),
      captured,
      captured.admission.assertCurrent,
      () => ({
        nativeLocations: [captured.admission.databasePath],
        admission: createSqliteWorkerOperationAdmission(admit),
      }),
    );
  return { store, run };
}

function relayWrite(index: number, relayId = "queued-writer-relay") {
  return {
    type: "nativeHookRelay.write",
    input: { record: { ...relayRecord(index), relayId }, updatedAtMs: index },
  } as const;
}

function readRelay(captured: OpenClawStateWorkerContext, relayId = "queued-writer-relay") {
  return executeOpenClawStateWorker(captured, {
    type: "nativeHookRelay.read",
    input: { relayId },
  });
}

const deviceToken = (deviceId: string, token = "synthetic-owner-token") => ({
  deviceId,
  token,
  role: "operator",
});
const rejection = (pending: Promise<unknown>) =>
  pending.then(
    () => undefined,
    (error: unknown) => error,
  );

function checkedAdmission(captured: OpenClawStateWorkerContext) {
  return {
    nativeLocations: [captured.admission.databasePath],
    admission: createSqliteWorkerOperationAdmission((request, grant) => {
      expect(request.stage).toBe("transaction");
      captured.admission.assertCurrent();
      expect(grant()).toBe(true);
    }),
  };
}

export function registerSharedStateWorkerAdmissionTests(
  createContext: () => OpenClawStateWorkerContext,
): void {
  it("requires the exact live maintenance owner through the worker commit grant", async () => {
    const captured = createContext();
    const { store, run } = await preparedStore(captured);
    const options = { path: captured.admission.databasePath, env: captured.environment };
    const database = openOpenClawStateDatabase(options);
    const owner = acquireGatewayStateOwner({ databasePath: database.path });
    const other = acquireGatewayStateOwner({
      databasePath: createContext().admission.databasePath,
    });
    const scopeFor = (authority: typeof owner, bound = true) =>
      createOpenClawDatabaseMaintenanceScope({
        schemaMaintenance: true,
        assertOwnerCurrent: authority.assertCurrent,
        ...(bound ? { assertDatabaseAccess: authority.assertDatabaseAccess } : {}),
      });
    const maintenance = scopeFor(owner);
    const wrongOwner = scopeFor(other);
    const unbound = scopeFor(owner, false);
    const stored = (deviceId: string) =>
      readDeviceAuthTokenObservationFromDatabase(database.db, { deviceId, role: "operator" }).entry;
    const stages: string[] = [];
    let lateOwner: ReturnType<typeof acquireGatewayStateOwner> | undefined;
    const write = (deviceId: string, beforeCommit?: () => void) =>
      run({ type: "deviceAuth.store", input: deviceToken(deviceId) }, (request, grant) => {
        stages.push(`${deviceId}:${request.stage}`);
        if (request.stage === "commit") {
          beforeCommit?.();
        }
        grant();
      });
    try {
      expect(() => openOpenClawStateDatabase(options)).toThrow(
        "without an active schema lease or maintenance scope",
      );
      expect(() =>
        runOpenClawStateWriteTransaction(
          ({ db }) => storeDeviceAuthTokenInDatabase(db, deviceToken("sync", "must-not-commit")),
          options,
        ),
      ).toThrow("without an active schema lease or maintenance scope");
      await expect(write("unrelated")).rejects.toThrow(
        "without an active schema lease or maintenance scope",
      );
      await expect(wrongOwner.run(() => write("wrong"))).rejects.toThrow("does not own");
      await expect(unbound.run(() => write("unbound"))).rejects.toThrow("does not own");
      expect(stages).toEqual([]);
      await expect(maintenance.run(() => write("accepted"))).resolves.toMatchObject({
        token: "synthetic-owner-token",
      });
      await expect(maintenance.run(() => write("revoked", () => owner.release()))).rejects.toThrow(
        "no longer current",
      );
      await expect(
        write("late", () => {
          lateOwner = acquireGatewayStateOwner({ databasePath: database.path });
        }),
      ).rejects.toThrow("without an active schema lease or maintenance scope");
      lateOwner?.release();
      expect(stages).toEqual(
        ["accepted", "revoked", "late"].flatMap((id) => [`${id}:transaction`, `${id}:commit`]),
      );
      expect(["sync", "unrelated", "wrong", "unbound", "revoked", "late"].map(stored)).toEqual(
        Array(6).fill(null),
      );
      expect(stored("accepted")?.token).toBe("synthetic-owner-token");
    } finally {
      lateOwner?.release();
      owner.release();
      other.release();
      await Promise.allSettled([maintenance.close(), wrongOwner.close(), unbound.close()]);
      await store.close();
    }
  });

  it.each([false, true])(
    "services direct broker commit admission while a native writer waits, single statement=%s",
    async (singleStatement) => {
      const captured = createContext();
      const { store, run } = await preparedStore(captured);
      const stages: string[] = [];
      let nativeFailure: unknown;
      let nativeWrites = 0;
      const workerInput = deviceToken("synthetic-broker-worker", "synthetic-worker-token");
      const nativeInput = { ...workerInput, deviceId: "synthetic-broker-native" };
      try {
        await run({ type: "deviceAuth.store", input: workerInput }, (request, grant) => {
          stages.push(request.stage);
          expect(grant()).toBe(true);
          if (request.stage === "transaction") {
            // The worker holds BEGIN IMMEDIATE and next needs its commit grant.
            try {
              runOpenClawStateWriteTransaction(
                ({ db }) => {
                  nativeWrites += 1;
                  return storeDeviceAuthTokenInDatabase(db, nativeInput);
                },
                { path: captured.admission.databasePath, env: captured.environment },
                singleStatement ? { singleStatement: true } : {},
              );
            } catch (error) {
              nativeFailure = error;
            }
          }
        });
        expect(nativeFailure).toBeUndefined();
        expect(nativeWrites).toBe(1);
        expect(stages).toEqual(["transaction", "commit"]);
        for (const input of [workerInput, nativeInput]) {
          expect(
            await store.execute({
              type: "deviceAuth.read",
              input: { deviceId: input.deviceId, role: input.role, readOnly: true },
            }),
          ).toMatchObject({
            entry: { token: input.token, role: input.role },
          });
        }
      } finally {
        await store.close();
      }
    },
  );

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
            const head = scope.execute(relayWrite(0));
            const headOutcome = Promise.allSettled([head]);
            const pending = scope.execute(relayWrite(1), { signal: canceled.signal });
            const outcome = rejection(pending);
            try {
              if (stop === "abort") {
                canceled.abort(stopped);
              } else if (stop === "revoke") {
                current = false;
                foreign.release();
              } else {
                await worker.terminate();
              }
              const error = await outcome;
              if (stop === "exit") {
                expect(error).toMatchObject({ code: "unavailable" });
              } else {
                expect(error).toBe(stopped);
              }
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
      const stored = await readRelay(captured);
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
        const head = scope.execute(relayWrite(0, "canceled-before-post"), {
          signal: canceled.signal,
        });
        const follower = scope.execute(relayWrite(1));
        const [first, second] = await Promise.allSettled([head, follower]);
        expect([first, second]).toEqual([
          { status: "rejected", reason: stopped },
          expect.objectContaining({ status: "fulfilled" }),
        ]);
      },
      {
        createAdmission: () => {
          if (++factories === 1) {
            canceled.abort(stopped);
          }
          return checkedAdmission(captured);
        },
      },
    );
    expect(factories).toBe(2);
    expect(await readRelay(captured, "canceled-before-post")).toBeUndefined();
    expect(await readRelay(captured)).toEqual(relayRecord(1));
  });

  it("retains FIFO and bounded capacity when canceling a queued write behind a native writer", async () => {
    const captured = createContext();
    await prepareSharedStateWorker(captured);
    const foreign = holdForeignWriter(captured);
    const canceled = new AbortController();
    const stopped = new Error("synthetic queued write canceled");
    const dispatched: number[] = [];
    // Read before postMessage transfers and detaches the serialized input.
    // oxlint-disable-next-line typescript/unbound-method -- call supplies the worker receiver.
    const nativePost = Worker.prototype.postMessage;
    const posts = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
      this: Worker,
      request: SqliteWorkerRequest,
      transferList,
    ) {
      const command =
        request.type === "execute"
          ? (deserialize(request.input) as SqliteWorkerCommand<OpenClawStateWorkerOperations>)
          : undefined;
      nativePost.call(this, request, transferList);
      if (command?.type === "nativeHookRelay.write") {
        dispatched.push(command.input.record.pid);
      }
    });
    let factories = 0;
    try {
      await runOpenClawStateWorkerOperation(
        captured,
        async (scope) => {
          const write = (index: number, signal?: AbortSignal) =>
            scope.execute(relayWrite(index), { signal });
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
          const canceledOutcome = rejection(queued);
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
            return checkedAdmission(captured);
          },
        },
      );
      expect(dispatched).toEqual([0, ...Array.from({ length: 255 }, (_, index) => index + 2)]);
      expect(factories).toBe(256);
      expect(await readRelay(captured)).toEqual(relayRecord(256));
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
