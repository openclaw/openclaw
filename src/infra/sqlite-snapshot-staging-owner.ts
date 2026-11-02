import { MessageChannel } from "node:worker_threads";
import {
  createRetainedOperation,
  finallyRetainedOperation,
  flatMapRetainedOperation,
  mapRetainedOperation,
  type RetainedOperation,
} from "@openclaw/worker-runtime/lifecycle";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { OpenClawStateWorkerErrorPayload } from "../state/openclaw-state-worker-error.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import { captureRuntimeWorkerSource } from "./runtime-worker-generation.js";
import { createSqliteLifecycleAggregateError } from "./sqlite-lifecycle-errors.js";
import {
  registerRetainedSnapshotTempDirectory,
  releaseRetainedSnapshotTempDirectory,
  startRemoveTempDirectory,
  sealRetainedSnapshotTempDirectory,
  SqliteSnapshotCleanupError,
} from "./sqlite-readonly-location-cleanup.js";
import { createSqliteReadOnlyNativeResourceConnection } from "./sqlite-readonly-native-resource.client.js";
import { SQLITE_NATIVE_RESOURCE_PORT } from "./sqlite-readonly-native-resource.types.js";
import {
  readOnlyWorkerScope,
  SqliteReadOnlyWorkerScopeClosedError,
} from "./sqlite-readonly-worker-context.js";
import { decodeSqliteSnapshotStagingError } from "./sqlite-snapshot-staging-error.js";
import type {
  SqliteSnapshotStagingCommand,
  SqliteSnapshotStagingDirectory,
  SqliteSnapshotStagingInput,
  SqliteSnapshotStagingRequest,
  SqliteSnapshotStagingReply,
} from "./sqlite-snapshot-staging.types.js";
import { recordWorkerMessage } from "./worker-message-metrics.js";
import {
  captureRetainedNativeWorkerSource,
  type RetainedNativeWorkerSource,
} from "./worker-native-lifecycle.js";
import {
  DEFAULT_WORKER_PENDING_BYTES,
  DEFAULT_WORKER_PENDING_TASKS,
} from "./worker-task-capacity.js";
import { createOwnedWorkerTaskPool } from "./worker-task-pool.js";

type SuccessfulReply = Exclude<SqliteSnapshotStagingReply, { type: "failed" }>;

function completed(): RetainedOperation<void> {
  const retained = createRetainedOperation<void>(() => {});
  retained.resolve(undefined);
  return retained.operation;
}

/** The existing staging owner retains its child; this transport only moves its event loop. */
function createStagingOwner(workerUrl: URL, nativeSource: RetainedNativeWorkerSource) {
  const nativeResource = nativeSource.captureResource(
    resolveRuntimeProcessEntrypointUrl("sqliteReadOnlyNativeResource"),
    SQLITE_NATIVE_RESOURCE_PORT,
    undefined,
    connectNativeResource,
  );
  const pool = createOwnedWorkerTaskPool<SqliteSnapshotStagingCommand, SqliteSnapshotStagingReply>(
    {
      workerUrl,
      workerClass: "writer",
      idleTimeoutMs: 0,
      maxPendingTasks: DEFAULT_WORKER_PENDING_TASKS,
      maxPendingBytes: DEFAULT_WORKER_PENDING_BYTES,
    },
    {
      retainedTransport: true,
      nativeSource,
      nativeResource,
      databaseAccess: "read-only",
      decodeResourceError: (payload) =>
        // SAFETY: The paired staging worker emits the SQLite codec in this opaque envelope.
        decodeSqliteSnapshotStagingError(payload as OpenClawStateWorkerErrorPayload | undefined),
    },
  );
  const directories = new Map<string, SqliteSnapshotStagingDirectory>();
  const failedDirectories = new Set<string>();
  const preparations = new Map<
    number,
    {
      directories: Set<string>;
      abort(): void;
      startClose(): RetainedOperation<void>;
      serviceClose(): void;
      releaseIfComplete(): void;
    }
  >();
  let preparationSequence = 0;
  const activeRequests = new Set<RetainedOperation<SuccessfulReply>>();
  let servicingRequests = false;
  let requests = 0;
  let scopes = 0;
  let admissionClosed = false;
  let idleClose: RetainedOperation<void> | undefined;
  let unavailable: { error: unknown } | undefined;

  function connectNativeResource() {
    const ownedDirectories = new Set<string>();
    return createSqliteReadOnlyNativeResourceConnection({
      receive(value) {
        const directory = value.directory;
        if (value.type === "allocated") {
          ownedDirectories.add(directory);
          const preparation = preparations.get(value.preparationId);
          if (!preparation) {
            throw new SqliteSnapshotCleanupError(
              "SQLite snapshot preparation custody is unavailable",
            );
          }
          preparation.directories.add(directory);
          retainDirectory(directory, value.preparationId);
        } else if (value.type === "retire") {
          if (!directories.has(directory)) {
            throw new SqliteSnapshotCleanupError("SQLite snapshot native custody is unavailable");
          }
          sealRetainedSnapshotTempDirectory(directory, { requireRequested: true });
        }
      },
      onFailure(error) {
        unavailable ??= { error };
      },
      onClosed() {
        for (const directory of ownedDirectories) {
          if (failedDirectories.delete(directory)) {
            releaseRetainedSnapshotTempDirectory(directory);
            directories.delete(directory);
            for (const preparation of preparations.values()) {
              preparation.directories.delete(directory);
              preparation.releaseIfComplete();
            }
          }
        }
      },
    });
  }

  const serviceRequests = () => {
    if (servicingRequests) {
      return;
    }
    servicingRequests = true;
    try {
      // A later caller must advance earlier custody through release of the shared slot.
      for (const request of activeRequests) {
        request.service();
      }
      for (const preparation of Array.from(preparations.values())) {
        preparation.serviceClose();
      }
    } finally {
      servicingRequests = false;
    }
  };

  const closeWhenIdle = (): RetainedOperation<void> => {
    if (idleClose?.read().status === "pending") {
      return idleClose;
    }
    if (requests > 0 || directories.size > failedDirectories.size) {
      return completed();
    }
    if (failedDirectories.size > 0) {
      const rotation = pool.startRotate();
      return (idleClose = finallyRetainedOperation(
        rotation,
        // Keep the cleanup error, then clear the pool's failed-stop latch after native join.
        () => (rotation.read().status === "rejected" ? pool.startRotate() : completed()),
        (error, cleanupError) =>
          createSqliteLifecycleAggregateError(
            [error, cleanupError],
            "SQLite snapshot native close failed",
            error,
          ),
      ));
    }
    if (scopes > 0 && !admissionClosed && unavailable === undefined) {
      return completed();
    }
    return (idleClose = mapRetainedOperation(
      flatMapRetainedOperation(pool.startCloseResources(), () =>
        requests > 0 ||
        directories.size > 0 ||
        (scopes > 0 && !admissionClosed && unavailable === undefined)
          ? completed()
          : pool.startRotate(),
      ),
      () => {
        unavailable = undefined;
      },
    ));
  };

  const retainDirectory = (
    directory: string,
    preparationId?: number,
  ): SqliteSnapshotStagingDirectory => {
    const existing = directories.get(directory);
    if (existing) {
      return existing;
    }
    let pending: RetainedOperation<void> | undefined;
    const startRetire = (): RetainedOperation<void> => {
      if (pending && pending.read().status !== "rejected") {
        return pending;
      }
      try {
        sealRetainedSnapshotTempDirectory(directory);
      } catch (error) {
        const refused = createRetainedOperation<void>(() => {});
        refused.reject(error);
        return refused.operation;
      }
      const removal = pool.startCloseResources(directory);
      return (pending = finallyRetainedOperation(
        mapRetainedOperation(removal, () => {
          directories.delete(directory);
          failedDirectories.delete(directory);
          if (preparationId !== undefined) {
            const preparation = preparations.get(preparationId);
            preparation?.directories.delete(directory);
            preparation?.releaseIfComplete();
          }
        }),
        () => {
          if (removal.read().status === "rejected") {
            failedDirectories.add(directory);
          }
          return closeWhenIdle();
        },
        (error, cleanupError) =>
          createSqliteLifecycleAggregateError(
            [error, cleanupError],
            "SQLite snapshot retirement failed",
            error,
          ),
      ));
    };
    const owned = { directory, startRetire };
    directories.set(directory, owned);
    registerRetainedSnapshotTempDirectory(directory, startRetire);
    return owned;
  };

  const start = (
    command: SqliteSnapshotStagingInput,
    signal?: AbortSignal,
  ): SqliteSnapshotStagingRequest => {
    if (admissionClosed) {
      throw new Error("SQLite snapshot staging owner is closing");
    }
    const preparationId = ++preparationSequence;
    const inputBytes = Buffer.byteLength(JSON.stringify({ ...command, preparationId }));
    const cancellation = command.type === "prepare" ? new MessageChannel() : undefined;
    const abort = () => {
      if (cancellation) {
        cancellation.port1.postMessage({ type: "abort" });
        recordWorkerMessage("resource", "to_worker");
      }
    };
    const input: SqliteSnapshotStagingCommand =
      command.type === "prepare" && cancellation
        ? { ...command, preparationId, abortPort: cancellation.port2 }
        : { ...command, preparationId };
    requests++;
    let pendingClose: RetainedOperation<void> | undefined;
    const preparation = {
      directories: new Set<string>(),
      abort() {
        if (task.read().status === "pending") {
          abort();
        }
      },
      startClose,
      serviceClose: () => pendingClose?.service(),
      releaseIfComplete() {
        if (request?.read().status !== "pending" && preparation.directories.size === 0) {
          preparations.delete(preparationId);
        }
      },
    };
    preparations.set(preparationId, preparation);
    const task = pool.startTask(
      () => {
        if (unavailable !== undefined) {
          throw unavailable.error;
        }
        signal?.throwIfAborted();
        signal?.addEventListener("abort", abort, { once: true });
        return input;
      },
      { inputBytes, transferList: () => (cancellation ? [cancellation.port2] : []) },
    );
    let release: RetainedOperation<void> | undefined;
    const result = mapRetainedOperation(task, (reply) => {
      if (reply.type === "failed") {
        const error = decodeSqliteSnapshotStagingError(reply.error);
        throw reply.cleanupFailure && !(error instanceof AggregateError)
          ? new SqliteSnapshotCleanupError(String(error), { cause: error })
          : error;
      }
      return reply;
    });
    const request: RetainedOperation<SuccessfulReply> = finallyRetainedOperation(
      result,
      () =>
        (release = finallyRetainedOperation(task.release(), () => {
          signal?.removeEventListener("abort", abort);
          cancellation?.port1.close();
          cancellation?.port2.close();
          requests--;
          return closeWhenIdle();
        })),
      (error, cleanupError) =>
        createSqliteLifecycleAggregateError(
          [error, cleanupError],
          "SQLite snapshot staging failed",
          error,
        ),
    );

    function startClose(): RetainedOperation<void> {
      if (pendingClose?.read().status === "pending") {
        return pendingClose;
      }
      let removals: Array<[string, RetainedOperation<boolean>, ErrorOptions]> | undefined;
      let servicing = false;
      const closing = createRetainedOperation<void>(() => {
        if (servicing || closing.operation.read().status !== "pending") {
          return;
        }
        servicing = true;
        try {
          serviceRequests();
          request.service();
          if (request.read().status === "pending") {
            return;
          }
          removals ??= [...preparation.directories].map(
            (directory): [string, RetainedOperation<boolean>, ErrorOptions] => {
              const failure: ErrorOptions = {};
              const removal = startRemoveTempDirectory(directory, (cause) => {
                failure.cause = cause;
              });
              void removal.result.then(
                () => closing.operation.service(),
                () => closing.operation.service(),
              );
              return [directory, removal, failure];
            },
          );
          for (const [directory, removal, failure] of removals) {
            removal.service();
            const outcome = removal.read();
            if (outcome.status === "pending") {
              return;
            }
            if (outcome.status === "rejected") {
              throw outcome.error;
            }
            if (!outcome.value) {
              throw new SqliteSnapshotCleanupError(
                `SQLite staging preparation cleanup failed: ${directory}`,
                failure,
              );
            }
          }
          const released = release?.read();
          if (released?.status === "rejected") {
            throw released.error;
          }
          preparation.releaseIfComplete();
          closing.resolve(undefined);
        } catch (error) {
          closing.reject(error);
        } finally {
          servicing = false;
        }
      });
      pendingClose = closing.operation;
      void request.result.then(
        () => closing.operation.service(),
        () => closing.operation.service(),
      );
      closing.operation.service();
      return closing.operation;
    }

    const finish = () => {
      activeRequests.delete(request);
      preparation.releaseIfComplete();
    };
    void request.result.then(finish, finish);
    if (request.read().status === "pending") {
      activeRequests.add(request);
    } else {
      finish();
    }
    return { ...request, service: serviceRequests, startClose };
  };

  const owner = {
    start,
    retainDirectory,
    retainScope() {
      scopes++;
      let released = false;
      return async () => {
        if (!released) {
          released = true;
          scopes--;
          await closeWhenIdle().result;
        }
      };
    },
  };
  nativeSource.retain(owner, async () => {
    admissionClosed = true;
    // Snapshot reads can stop; token allocation and native cleanup still join normally.
    for (const preparation of preparations.values()) {
      preparation.abort();
    }
    await Promise.allSettled([...activeRequests].map((request) => request.result));
    const closures = Array.from(preparations.values()).map((preparation) =>
      preparation.startClose(),
    );
    const outcomes = await Promise.allSettled(closures.map((close) => close.result));
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    if (failures.length) {
      throw createSqliteLifecycleAggregateError(
        failures,
        "SQLite snapshot generation cleanup failed",
        failures[0],
      );
    }
    await closeWhenIdle().result;
    await pool.close();
  });
  return owner;
}

export function captureSqliteSnapshotStagingOwner() {
  const scope = readOnlyWorkerScope.getStore();
  if (scope) {
    if (!scope.active) {
      throw new SqliteReadOnlyWorkerScopeClosedError();
    }
    scope.controller.signal.throwIfAborted();
  }
  const { moduleUrl, runtimeGeneration } = captureRuntimeWorkerSource(
    resolveRuntimeProcessEntrypointUrl("sqliteSnapshotStaging"),
  );
  const nativeSource = captureRetainedNativeWorkerSource({ runtimeGeneration });
  const owners = resolveGlobalSingleton(
    Symbol.for("openclaw.sqliteSnapshotStagingOwner"),
    () => new WeakMap<RetainedNativeWorkerSource, ReturnType<typeof createStagingOwner>>(),
  );
  let owner = owners.get(nativeSource);
  if (!owner) {
    owner = runInDetachedAsyncContext(() => createStagingOwner(moduleUrl, nativeSource));
    owners.set(nativeSource, owner);
  }
  if (scope && !scope.stagingOwners.has(owner)) {
    scope.stagingOwners.set(owner, owner.retainScope());
  }
  return owner;
}
