import { createHash } from "node:crypto";
import fs from "node:fs";
import { MessagePort, Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseAsync,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as tokens from "./device-auth-store.js";
import { storeDeviceAuthTokenInDatabase } from "./device-auth-store.kernel.js";
import { sqliteWorkerPreloadEnv } from "./sqlite-worker-preload.test-support.js";
import * as sqliteWorkers from "./sqlite-worker-store.js";
import {
  captureStateDatabaseCoordinatorRuntime,
  resolveStateDatabaseCoordinatorPath,
} from "./state-database-coordinator.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  { length: 32, ownerCurrent: true, queuedFollower: true, nested: false, preparation: false },
  {
    length: 65 * 1024 * 1024,
    ownerCurrent: true,
    queuedFollower: true,
    nested: false,
    preparation: false,
  },
  { length: 32, ownerCurrent: false, queuedFollower: true, nested: false, preparation: false },
  { length: 32, ownerCurrent: true, queuedFollower: false, nested: false, preparation: false },
  { length: 32, ownerCurrent: true, queuedFollower: false, nested: true, preparation: false },
  {
    length: 32,
    ownerCurrent: true,
    queuedFollower: false,
    nested: "cross-scope" as const,
    preparation: false,
  },
  { length: 32, ownerCurrent: false, queuedFollower: false, nested: false, preparation: true },
])(
  "preserves a settled $length-byte token outcome through cleanup failure (owner current: $ownerCurrent, queued follower: $queuedFollower, nested: $nested, preparation: $preparation)",
  async ({ length, ownerCurrent, queuedFollower, nested, preparation }) => {
    await withOpenClawTestState({ label: "worker-lifecycle-cleanup" }, async (state) => {
      const databasePath = state.statePath("state", "openclaw.sqlite");
      const coordinatorPath = resolveStateDatabaseCoordinatorPath({
        databasePath,
        runtimeDirectory: captureStateDatabaseCoordinatorRuntime().directory,
        uid: process.getuid?.(),
      });
      const entered = state.path("transaction-entered");
      const failed = state.path("cleanup-failed");
      const preload = state.path("cleanup-preload.cjs");
      fs.writeFileSync(
        preload,
        `
const { MessagePort, isMainThread } = require("node:worker_threads");
if (!isMainThread) {
  const fs = require("node:fs");
  const { DatabaseSync } = require("node:sqlite");
  let transactions = 0;
  let armed = false;
  let failedDatabase;
  const post = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function(message, ...rest) {
    if (message?.stage === "transaction") transactions += 1;
    if (${preparation}
      ? message?.type === "acquired" && transactions === 1
      : message?.stage === "transaction" && transactions === 2) {
      armed = true;
      fs.writeFileSync(${JSON.stringify(entered)}, "entered");
    }
    return Reflect.apply(post, this, [message, ...rest]);
  };
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql) {
    if (armed && sql === "ROLLBACK" && this.location() === ${JSON.stringify(coordinatorPath)}) {
      armed = false;
      failedDatabase = this;
      fs.writeFileSync(${JSON.stringify(failed)}, "one cleanup failure");
      throw new Error("Synthetic coordinator rollback failure");
    }
    return Reflect.apply(exec, this, [sql]);
  };
  const close = DatabaseSync.prototype.close;
  DatabaseSync.prototype.close = function(...args) {
    if (this === failedDatabase) {
      failedDatabase = undefined;
      throw new Error("Synthetic coordinator close failure");
    }
    return Reflect.apply(close, this, args);
  };
}
`,
      );
      for (const [key, value] of Object.entries(sqliteWorkerPreloadEnv(preload))) {
        vi.stubEnv(key, value);
      }
      const lookup = { deviceId: "synthetic-cleanup-device", role: "operator", env: state.env };
      const posts = vi.spyOn(Worker.prototype, "postMessage");
      await tokens.storeDeviceAuthToken({ ...lookup, token: "synthetic-before" });
      const worker = posts.mock.contexts[0];
      posts.mockRestore();
      if (!(worker instanceof Worker)) {
        throw new Error("Expected the shared-state worker");
      }
      let exited = false;
      worker.once("exit", () => {
        exited = true;
      });
      const warnings = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
      // Keep the native implementation callable with the actual sending port.
      const nativePost = vi.spyOn(MessagePort.prototype, "postMessage");
      nativePost.mockRestore();
      let nativeWrites = 0;
      let current = true;
      const refused = new Error("Synthetic token authority revoked");
      const dispatch = vi
        .spyOn(MessagePort.prototype, "postMessage")
        .mockImplementation(function (this: MessagePort, message, transferList) {
          const result = nativePost.call(this, message, transferList);
          if (
            !isRecord(message) ||
            message.type !== "accepted" ||
            (preparation
              ? message.admission !== undefined
              : !(message.admission instanceof MessagePort))
          ) {
            return result;
          }
          dispatch.mockRestore();
          const deadline = Date.now() + 5_000;
          const pause = new Int32Array(new SharedArrayBuffer(4));
          while (!fs.existsSync(entered)) {
            if (Date.now() >= deadline) {
              throw new Error("Worker did not reach its transaction grant");
            }
            Atomics.wait(pause, 0, 0, 1);
          }
          current = ownerCurrent;
          runOpenClawStateWriteTransaction(
            ({ db }) => {
              nativeWrites += 1;
              storeDeviceAuthTokenInDatabase(db, {
                deviceId: "synthetic-native-device",
                role: "operator",
                token: "synthetic-native-token",
              });
            },
            { env: state.env },
          );
          return result;
        });
      const token = "x".repeat(length);
      const mutate = () =>
        tokens.storeDeviceAuthToken({
          ...lookup,
          token,
          expectedToken: "synthetic-before",
          assertCurrent() {
            if (!current) {
              throw refused;
            }
          },
        });
      const escape = createDeferredCore<never>();
      void escape.promise.catch(() => {});
      const nestedScopes =
        nested === "cross-scope"
          ? {
              parent: createOpenClawDatabaseMaintenanceScope(),
              child: createOpenClawDatabaseMaintenanceScope(),
            }
          : undefined;
      const operations = vi.spyOn(sqliteWorkers, "runSqliteWorkerStoreOperation");
      let parentStore: object | undefined;
      let parentActor: object | undefined;
      let nestedWork: ReturnType<typeof mutate> | undefined;
      const mutation = nested
        ? runOpenClawStateWorkerOperation(
            nestedScopes
              ? nestedScopes.parent.run(() => captureOpenClawStateWorkerContext({ env: state.env }))
              : captureOpenClawStateWorkerContext({ env: state.env }),
            () => {
              if (nestedScopes) {
                parentStore = operations.mock.calls.at(-1)?.[0];
                if (!parentStore) {
                  throw new Error("Expected the enclosing callback's current client");
                }
                parentActor = sqliteWorkers.getSqliteWorkerActorIdentity(parentStore);
              }
              nestedWork = (async () => {
                if (nestedScopes) {
                  await nestedScopes.child.run(() =>
                    runOpenClawStateWorkerOperation(
                      captureOpenClawStateWorkerContext({ env: state.env }),
                      async () => {
                        const store = operations.mock.calls.at(-1)?.[0];
                        if (!store) {
                          throw new Error("Expected the nested callback's current client");
                        }
                        expect(store).not.toBe(parentStore);
                        expect(sqliteWorkers.getSqliteWorkerActorIdentity(store)).toBe(parentActor);
                      },
                    ),
                  );
                }
                const result = await (nestedScopes ? nestedScopes.child.run(mutate) : mutate());
                await expect(tokens.loadDeviceAuthToken(lookup)).rejects.toMatchObject({
                  code: "unavailable",
                });
                return result;
              })();
              void nestedWork.catch(() => {});
              return Promise.race([nestedWork, escape.promise]);
            },
          )
        : mutate();
      let completed = false;
      void mutation.then(
        () => {
          completed = true;
        },
        () => {
          completed = true;
        },
      );
      const follower = queuedFollower
        ? tokens.loadDeviceAuthToken(lookup).then(
            () => ({ failed: false, exited }),
            (error: unknown) => ({ failed: true, exited, error }),
          )
        : undefined;
      try {
        if (nested) {
          await expect.poll(() => completed, { timeout: 5_000 }).toBe(true);
        }
        const hash = (value: string) => createHash("sha256").update(value).digest("hex");
        if (ownerCurrent) {
          const result = await mutation;
          expect(result?.token.length).toBe(length);
          expect(hash(result?.token ?? "")).toBe(hash(token));
        } else if (preparation) {
          const failure: unknown = await mutation.catch((error: unknown) => error);
          expect(failure).toBeInstanceOf(Error);
          expect(failure instanceof AggregateError ? failure.errors[0] : failure).toMatchObject({
            code: "unavailable",
          });
        } else {
          await expect(mutation).rejects.toBe(refused);
        }
        expect(exited).toBe(true);
        expect(fs.readFileSync(failed, "utf8")).toBe("one cleanup failure");
        expect(nativeWrites).toBe(1);
        if (follower) {
          expect(await follower).toMatchObject({
            failed: true,
            exited: true,
            error: { code: "unavailable" },
          });
        }
        if (!preparation) {
          expect(warnings).toHaveBeenCalledWith(
            expect.objectContaining({
              message: "SQLite worker operation completed before coordinator cleanup failed",
            }),
          );
        }
        expect(hash((await tokens.loadDeviceAuthToken(lookup))?.token ?? "")).toBe(
          hash(ownerCurrent ? token : "synthetic-before"),
        );
        await closeOpenClawStateDatabaseAsync();
        expect(hash((await tokens.loadDeviceAuthToken(lookup))?.token ?? "")).toBe(
          hash(ownerCurrent ? token : "synthetic-before"),
        );
        expect(
          await tokens.loadDeviceAuthToken({ ...lookup, deviceId: "synthetic-native-device" }),
        ).toMatchObject({ token: "synthetic-native-token" });
      } finally {
        escape.reject(new Error("Release nested fixture after observation"));
        dispatch.mockRestore();
        await Promise.allSettled([mutation, follower, nestedWork]);
        await Promise.allSettled([nestedScopes?.child.close(), nestedScopes?.parent.close()]);
        await closeOpenClawStateDatabaseAsync();
        warnings.mockRestore();
        vi.unstubAllEnvs();
      }
    });
  },
);
