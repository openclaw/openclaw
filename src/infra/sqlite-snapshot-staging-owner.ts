import { AsyncLocalStorage } from "node:async_hooks";
import { MessageChannel } from "node:worker_threads";
import {
  createRetainedOperation,
  type RetainedOperation,
} from "@openclaw/worker-runtime/lifecycle";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import { captureRuntimeWorkerSource } from "./runtime-worker-generation.js";
import { createSqliteLifecycleAggregateError } from "./sqlite-lifecycle-errors.js";
import {
  registerRetainedSnapshotTempDirectory,
  startRemoveTempDirectory,
  sealRetainedSnapshotTempDirectory,
  SqliteSnapshotCleanupError,
} from "./sqlite-readonly-location-cleanup.js";
import { createSqliteReadOnlyNativeResourceConnection } from "./sqlite-readonly-native-resource.client.js";
import { SQLITE_NATIVE_RESOURCE_PORT } from "./sqlite-readonly-native-resource.types.js";
import { decodeSqliteSnapshotStagingError } from "./sqlite-snapshot-staging-error.js";
import type {
  SqliteSnapshotStagingCommand,
  SqliteSnapshotStagingDirectory,
  SqliteSnapshotStagingInput,
  SqliteSnapshotStagingRequest,
  SqliteSnapshotStagingReply,
} from "./sqlite-snapshot-staging.types.js";
import {
  captureRetainedNativeWorkerSource,
  type RetainedNativeWorkerSource,
} from "./worker-native-lifecycle.js";
import {
  DEFAULT_WORKER_PENDING_BYTES,
  DEFAULT_WORKER_PENDING_TASKS,
} from "./worker-task-capacity.js";
import { createOwnedWorkerTaskPool } from "./worker-task-pool.js";
import type { RetainedWorkerTask } from "./worker-task-pool.types.js";

type SuccessfulReply = Exclude<SqliteSnapshotStagingReply, { type: "failed" }>;

/** The existing staging owner retains its child; this transport only moves its event loop. */
function createStagingOwner(workerUrl: URL, nativeSource: RetainedNativeWorkerSource) {
  const nativeDirectories = new Map<
    string,
    { owner: { disposed: boolean }; preparationId: number; removed: boolean; recovering: boolean }
  >();
  const nativeResource = nativeSource.captureResource(
    resolveRuntimeProcessEntrypointUrl("sqliteReadOnlyNativeResource"),
    SQLITE_NATIVE_RESOURCE_PORT,
    undefined,
    connectNativeResource,
  );
  const pool = createOwnedWorkerTaskPool<SqliteSnapshotStagingCommand, SqliteSnapshotStagingReply>(
    {
      workerUrl,
      maxWorkers: 1,
      idleTimeoutMs: 0,
      maxPendingTasks: DEFAULT_WORKER_PENDING_TASKS,
      maxPendingBytes: DEFAULT_WORKER_PENDING_BYTES,
    },
    {
      retainedTransport: true,
      nativeSource,
      nativeResource,
      decodeResourceError: decodeSqliteSnapshotStagingError,
    },
  );
  const directories = new Map<string, SqliteSnapshotStagingDirectory>();
  const preparations = new Map<
    number,
    {
      directories: Set<string>;
      closeRequested: boolean;
      isAdmitted(): boolean;
      acceptOwner(owner: { disposed: boolean }): void;
      startClose(): RetainedOperation<void>;
      serviceClose(): void;
      releaseIfComplete(): void;
    }
  >();
  let preparationSequence = 0;
  const activeRequests = new Set<RetainedOperation<SuccessfulReply>>();
  let servicingRequests = false;
  let requests = 0;
  let admissionClosed = false;
  let idleClose: RetainedOperation<void> | undefined;
  let unavailable: { error: unknown } | undefined;

  function connectNativeResource() {
    return createSqliteReadOnlyNativeResourceConnection({
      receive(value, owner) {
        const directory = value.directory;
        const existing = nativeDirectories.get(directory);
        if (value.type === "allocated") {
          const preparation = preparations.get(value.preparationId);
          if (!preparation?.isAdmitted()) {
            throw new SqliteSnapshotCleanupError(
              "SQLite snapshot preparation custody is unavailable",
            );
          }
          preparation.acceptOwner(owner);
          if (
            existing &&
            (existing.owner !== owner || existing.preparationId !== value.preparationId)
          ) {
            throw new SqliteSnapshotCleanupError(
              "SQLite snapshot changed its original native owner",
            );
          }
          if (!existing) {
            nativeDirectories.set(directory, {
              owner,
              preparationId: value.preparationId,
              removed: false,
              recovering: false,
            });
          }
          preparation.directories.add(directory);
          retainDirectory(directory);
          if (preparation.closeRequested) {
            try {
              sealRetainedSnapshotTempDirectory(directory);
            } catch {
              // The request's actual removal reports a held reader; allocation still records custody.
            }
          }
        } else {
          if (existing?.owner !== owner) {
            throw new SqliteSnapshotCleanupError("SQLite snapshot native custody is unavailable");
          }
          if (value.type === "retire") {
            sealRetainedSnapshotTempDirectory(directory, { requireRequested: true });
            existing.recovering = true;
          } else if (value.type === "removed") {
            existing.removed = true;
          }
        }
      },
      onFailure(error) {
        unavailable ??= { error };
      },
      onDispose(owner) {
        for (const [directory, record] of nativeDirectories) {
          if (record.owner === owner && record.removed && !directories.has(directory)) {
            nativeDirectories.delete(directory);
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
    let close: RetainedOperation<void> | undefined;
    let rotate: RetainedOperation<void> | undefined;
    const retained = createRetainedOperation<void>(() => {
      if (retained.operation.read().status !== "pending") {
        return;
      }
      if (!close) {
        if (requests > 0 || directories.size > 0) {
          return retained.resolve(undefined);
        }
        close = pool.startCloseResources();
        void close.result.then(serviceIdleClose, serviceIdleClose);
      }
      close.service();
      const closed = close.read();
      if (closed.status === "pending") {
        return;
      }
      if (closed.status === "rejected") {
        return retained.reject(closed.error);
      }
      if (!rotate) {
        if (requests > 0 || directories.size > 0) {
          return retained.resolve(undefined);
        }
        rotate = pool.startRotate();
        void rotate.result.then(serviceIdleClose, serviceIdleClose);
      }
      rotate.service();
      const rotated = rotate.read();
      if (rotated.status === "fulfilled") {
        unavailable = undefined;
        retained.resolve(undefined);
      } else if (rotated.status === "rejected") {
        retained.reject(rotated.error);
      }
    });
    const serviceIdleClose = retained.operation.service.bind(retained.operation);
    idleClose = retained.operation;
    retained.operation.service();
    return retained.operation;
  };

  const retainDirectory = (directory: string): SqliteSnapshotStagingDirectory => {
    const existing = directories.get(directory);
    if (existing) {
      return existing;
    }
    const preparationId = nativeDirectories.get(directory)?.preparationId;
    let pending: RetainedOperation<void> | undefined;
    let removed = false;
    const startRetire = (): RetainedOperation<void> => {
      if (pending?.read().status === "pending") {
        return pending;
      }
      let cleanup: RetainedOperation<void> | undefined;
      let closing: RetainedOperation<void> | undefined;
      const retained = createRetainedOperation<void>(() => {
        if (retained.operation.read().status !== "pending") {
          return;
        }
        if (!removed) {
          const nativeDirectory = nativeDirectories.get(directory);
          if (!nativeDirectory?.removed || !nativeDirectory.recovering) {
            if (!cleanup) {
              try {
                // Re-imported callers share this reader fence with the retained native owner.
                sealRetainedSnapshotTempDirectory(directory);
                cleanup = pool.startCloseResources(directory);
              } catch (error) {
                retained.reject(error);
                return;
              }
              void cleanup.result.then(serviceDirectoryClose, serviceDirectoryClose);
            }
            cleanup.service();
            const outcome = cleanup.read();
            if (outcome.status === "pending") {
              return;
            }
            if (outcome.status === "rejected") {
              retained.reject(outcome.error);
              return;
            }
            if (!nativeDirectories.get(directory)?.removed) {
              retained.reject(
                new SqliteSnapshotCleanupError(
                  `SQLite snapshot native owner did not confirm directory removal: ${directory}`,
                ),
              );
              return;
            }
          }
          removed = true;
          directories.delete(directory);
          if (!nativeDirectory?.recovering || nativeDirectory.owner.disposed) {
            nativeDirectories.delete(directory);
          }
        }
        if (!closing) {
          closing = closeWhenIdle();
          void closing.result.then(serviceDirectoryClose, serviceDirectoryClose);
        }
        closing.service();
        const outcome = closing.read();
        if (outcome.status === "fulfilled") {
          if (preparationId !== undefined) {
            const preparation = preparations.get(preparationId);
            preparation?.directories.delete(directory);
            preparation?.releaseIfComplete();
          }
          retained.resolve(undefined);
        } else if (outcome.status === "rejected") {
          retained.reject(outcome.error);
        }
      });
      const serviceDirectoryClose = retained.operation.service.bind(retained.operation);
      pending = retained.operation;
      retained.operation.service();
      return retained.operation;
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
    const runInContext = AsyncLocalStorage.snapshot();
    const priorClose = idleClose;
    priorClose?.service();
    const cancellation = command.type === "prepare" ? new MessageChannel() : undefined;
    const abort = () => cancellation?.port1.postMessage({ type: "abort" });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
    const input: SqliteSnapshotStagingCommand =
      command.type === "prepare" && cancellation
        ? { ...command, preparationId, abortPort: cancellation.port2 }
        : { ...command, preparationId };
    requests++;
    let inputPrepared = false;
    let task: RetainedWorkerTask<SqliteSnapshotStagingReply> | undefined;
    let admissionFailure: { error: unknown } | undefined;
    let custodyReleased = false;
    let pendingClose: RetainedOperation<void> | undefined;
    let closeService: (() => void) | undefined;
    let admitting = true;
    let originalNativeOwner: { disposed: boolean } | undefined;
    let release: RetainedOperation<void> | undefined;
    let closing: RetainedOperation<void> | undefined;
    let observed = false;
    let reply: SuccessfulReply | undefined;
    let refusedByCleanup: SqliteSnapshotCleanupError | undefined;
    const errors: unknown[] = [];
    let servicing = false;
    const retained = createRetainedOperation<SuccessfulReply>(() => runInContext(service));
    const serviceRequest = retained.operation.service.bind(retained.operation);
    const preparation = {
      directories: new Set<string>(),
      closeRequested: false,
      isAdmitted: () => inputPrepared,
      acceptOwner(owner: { disposed: boolean }) {
        if (originalNativeOwner && originalNativeOwner !== owner) {
          throw new SqliteSnapshotCleanupError(
            "SQLite preparation changed its original native owner",
          );
        }
        originalNativeOwner = owner;
      },
      startClose,
      serviceClose: () => closeService?.(),
      releaseIfComplete,
    };
    preparations.set(preparationId, preparation);
    try {
      task = pool.startTask(
        () => {
          if (unavailable !== undefined) {
            throw unavailable.error;
          }
          signal?.throwIfAborted();
          inputPrepared = true;
          return input;
        },
        {
          inputBytes,
          transferList: () => (cancellation ? [cancellation.port2] : []),
        },
      );
    } catch (error) {
      admissionFailure = { error };
      requests--;
      signal?.removeEventListener("abort", abort);
      cancellation?.port1.close();
      cancellation?.port2.close();
    }
    admitting = false;
    function service() {
      if (admitting || servicing || retained.operation.read().status !== "pending") {
        return;
      }
      servicing = true;
      try {
        priorClose?.service();
        const previous = priorClose?.read();
        const failure = unavailable ?? (previous?.status === "rejected" ? previous : undefined);
        if (failure && !inputPrepared && task?.read().status === "pending") {
          refusedByCleanup = new SqliteSnapshotCleanupError(
            "SQLite snapshot staging cleanup failed before admission",
            { cause: failure.error },
          );
          // Release unprepared input when its original owner fails or its rotation is refused.
          release = task.release();
        }
        if (!task) {
          retained.reject(
            admissionFailure?.error ?? new Error("SQLite staging task is unavailable"),
          );
          return;
        }
        task.service();
        const result = task.read();
        if (result.status === "pending") {
          return;
        }
        if (!observed) {
          observed = true;
          if (result.status === "rejected") {
            errors.push(refusedByCleanup ?? result.error);
            // An unexpected transport loss cannot make a replacement actor own old tokens.
            if (inputPrepared && directories.size > 0) {
              unavailable = { error: result.error };
            }
          } else if (result.value.type === "failed") {
            if (result.value.directory && !preparation.directories.has(result.value.directory)) {
              errors.push(
                new SqliteSnapshotCleanupError(
                  "SQLite staging failure lost its original directory custody",
                ),
              );
            }
            const error = decodeSqliteSnapshotStagingError(result.value.error);
            errors.push(
              result.value.cleanupFailure && !(error instanceof AggregateError)
                ? new SqliteSnapshotCleanupError(String(error), { cause: error })
                : error,
            );
          } else {
            if (!preparation.directories.has(result.value.directory)) {
              errors.push(
                new SqliteSnapshotCleanupError(
                  "SQLite staging result lost its original directory custody",
                ),
              );
            } else {
              reply = result.value;
            }
          }
          release ??= task.release();
          void release.result.then(serviceRequest, serviceRequest);
        }
        release!.service();
        const released = release!.read();
        if (released.status === "pending") {
          return;
        }
        if (!closing) {
          signal?.removeEventListener("abort", abort);
          cancellation?.port1.close();
          cancellation?.port2.close();
          requests--;
          if (released.status === "rejected") {
            errors.push(released.error);
          }
          closing = closeWhenIdle();
          void closing.result.then(serviceRequest, serviceRequest);
        }
        closing.service();
        const closed = closing.read();
        if (closed.status === "pending") {
          return;
        }
        if (closed.status === "rejected") {
          errors.push(closed.error);
        }
        if (errors.length > 1) {
          retained.reject(
            createSqliteLifecycleAggregateError(
              errors,
              "SQLite snapshot staging failed",
              errors[0],
            ),
          );
        } else if (errors.length === 1) {
          retained.reject(errors[0]);
        } else if (reply) {
          retained.resolve(reply);
        } else {
          retained.reject(new Error("SQLite snapshot staging returned no outcome"));
        }
      } finally {
        servicing = false;
        if (retained.operation.read().status !== "pending") {
          activeRequests.delete(retained.operation);
          releaseIfComplete();
        }
      }
    }

    function releaseIfComplete() {
      if (
        retained.operation.read().status !== "pending" &&
        pendingClose?.read().status !== "pending" &&
        preparation.directories.size === 0 &&
        release?.read().status === "fulfilled" &&
        closing?.read().status === "fulfilled"
      ) {
        custodyReleased = true;
        preparations.delete(preparationId);
      }
    }

    function startClose(): RetainedOperation<void> {
      preparation.closeRequested = true;
      if (pendingClose?.read().status === "pending") {
        return pendingClose;
      }
      let rawRelease: RetainedOperation<void> | undefined;
      const removals = new Map<string, RetainedOperation<boolean>>();
      const removalFailures = new Map<string, unknown>();
      let servicingClose = false;
      const completion = createRetainedOperation<void>(() =>
        runInContext(() => {
          if (admitting) {
            return;
          }
          if (servicingClose || completion.operation.read().status !== "pending") {
            return;
          }
          servicingClose = true;
          try {
            if (custodyReleased) {
              completion.resolve();
              return;
            }
            if (!task) {
              throw new SqliteSnapshotCleanupError(
                "SQLite staging admission did not return its original task custody",
                { cause: admissionFailure?.error },
              );
            }
            for (;;) {
              // Intent is per request. A lost VM may ask before its late allocation reply arrives.
              for (const directory of preparation.directories) {
                try {
                  sealRetainedSnapshotTempDirectory(directory);
                } catch {
                  // Canonical removal below rechecks and reports reader refusal.
                }
              }
              serviceRequests();
              task.service();
              if (task.read().status === "pending") {
                return;
              }
              const failures: unknown[] = [];
              for (const directory of preparation.directories) {
                let removal = removals.get(directory);
                if (!removal) {
                  removal = startRemoveTempDirectory(directory, (error) =>
                    removalFailures.set(directory, error),
                  );
                  removals.set(directory, removal);
                  void removal.result.then(serviceRequestClose, serviceRequestClose);
                }
              }
              for (const [directory, removal] of removals) {
                removal.service();
                const removed = removal.read();
                if (removed.status === "pending") {
                  return;
                }
                if (removed.status === "rejected") {
                  failures.push(removed.error);
                } else if (!removed.value) {
                  failures.push(
                    removalFailures.get(directory) ??
                      new SqliteSnapshotCleanupError(
                        `SQLite staging preparation cleanup failed: ${directory}`,
                      ),
                  );
                }
              }
              if (failures.length) {
                throw createSqliteLifecycleAggregateError(
                  failures,
                  "SQLite staging preparation cleanup failed",
                  failures[0],
                );
              }
              if (!rawRelease) {
                // Retry this task's native custody, never a replacement task or sibling source.
                rawRelease = task.release();
                void rawRelease.result.then(serviceRequestClose, serviceRequestClose);
              }
              rawRelease.service();
              const joined = rawRelease.read();
              if (joined.status === "pending") {
                return;
              }
              if (joined.status === "rejected") {
                throw joined.error;
              }
              // Servicing release may deliver a previously unpublished allocation fact.
              if (preparation.directories.size > 0) {
                if ([...preparation.directories].some((directory) => !removals.has(directory))) {
                  continue;
                }
                throw new SqliteSnapshotCleanupError(
                  "SQLite staging directory custody was not released",
                );
              }
              service();
              if (retained.operation.read().status === "pending") {
                return;
              }
              const idle = closing?.read();
              if (inputPrepared && idle?.status === "rejected" && removals.size === 0) {
                // No owned removal can prove recovery of this original no-directory close failure.
                throw idle.error;
              }
              custodyReleased = true;
              preparations.delete(preparationId);
              completion.resolve();
              return;
            }
          } catch (error) {
            completion.reject(error);
          } finally {
            servicingClose = false;
          }
        }),
      );
      const serviceRequestClose = completion.operation.service.bind(completion.operation);
      closeService = serviceRequestClose;
      pendingClose = { ...completion.operation, service: serviceRequests };
      if (task) {
        void task.result.then(serviceRequestClose, serviceRequestClose);
      }
      void retained.operation.result.then(serviceRequestClose, serviceRequestClose);
      completion.operation.service();
      return pendingClose;
    }

    void priorClose?.result.then(serviceRequest, serviceRequest);
    if (task) {
      void task.result.then(serviceRequest, serviceRequest);
    }
    activeRequests.add(retained.operation);
    retained.operation.service();
    closeService?.();
    return { ...retained.operation, service: serviceRequests, startClose };
  };

  const owner = {
    start,
    retainDirectory,
  };
  nativeSource.retain(owner, async () => {
    admissionClosed = true;
    for (const preparation of preparations.values()) {
      preparation.closeRequested = true;
    }
    await Promise.allSettled([...activeRequests].map((request) => request.result));
    // A lost Worker shares native cleanup across roots; admit eligible siblings first.
    for (const directory of directories.keys()) {
      try {
        sealRetainedSnapshotTempDirectory(directory);
      } catch {
        // Removal below rechecks and reports refusal, including readers released meanwhile.
      }
    }
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
  return owner;
}
