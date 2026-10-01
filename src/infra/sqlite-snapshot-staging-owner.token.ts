import path from "node:path";
import { hasErrnoCode } from "./errno.js";
import {
  createRetainedOperation,
  mapRetainedOperation,
  type RetainedOperation,
} from "./retained-operation.js";
import { SqliteSnapshotCleanupError } from "./sqlite-readonly-location-cleanup.js";
import { captureSqliteReadOnlyWorkerLaunch } from "./sqlite-readonly-worker.js";
import type {
  SqliteSnapshotStagingInput,
  SqliteSnapshotStagingReply,
  SqliteSnapshotStagingRequest,
  SqliteStagingNativeDirectory,
  SqliteStagingOwnedToken,
  WorkerOwnedSqliteStagingToken,
  WorkerOwnedSqliteStagingTokenAdmission,
} from "./sqlite-snapshot-staging.types.js";
import {
  captureSqliteStagingTokenIdentity,
  readSqliteStagingTokenIdentity,
  type SqliteStagingTokenIdentity,
} from "./sqlite-staging-token.js";
import type { RetainedWorkerTask } from "./worker-task-pool.types.js";

export function sameTokenIdentity(
  left: SqliteStagingTokenIdentity,
  right: SqliteStagingTokenIdentity,
): boolean {
  return (
    left.directory.dev === right.directory.dev &&
    left.directory.ino === right.directory.ino &&
    left.token.dev === right.token.dev &&
    left.token.ino === right.token.ino
  );
}

function normalizeTokenCleanupError(error: unknown): unknown {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof AggregateError) {
    if (seen.has(current) || current.errors.length !== 1) {
      return error;
    }
    seen.add(current);
    const nested: unknown = current.errors[0];
    if (current.cause !== undefined && current.cause !== nested) {
      return error;
    }
    current = nested;
  }
  if (current !== error && hasErrnoCode(current, "ENOENT")) {
    let cause: unknown = current;
    while (cause instanceof Error && cause.cause !== undefined) {
      if (seen.has(cause) || !hasErrnoCode(cause, "ENOENT")) {
        return error;
      }
      seen.add(cause);
      cause = cause.cause;
    }
    if (seen.has(cause) || !hasErrnoCode(cause, "ENOENT")) {
      return error;
    }
    return Object.assign(
      new Error("SQLite staging token cleanup could not find its original path", { cause: error }),
      { code: "ENOENT" },
    );
  }
  return error;
}

export function createOwnedStagingToken(options: {
  input: Extract<SqliteSnapshotStagingInput, { type: "token" }>;
  preparationId: number;
  inContext: <T>(run: () => T) => T;
  isAdmitting: () => boolean;
  isInputPrepared: () => boolean;
  isAdmissionClosed: () => boolean;
  task: () => RetainedWorkerTask<SqliteSnapshotStagingReply> | undefined;
  originalNativeOwner: () => { disposed: boolean } | undefined;
  nativeDirectory: () => SqliteStagingNativeDirectory | undefined;
  serviceAdmission: () => void;
  admissionResult: Promise<unknown>;
  requestClose: () => void;
  startCloseResource: () => RetainedOperation<void>;
  closeWhenIdle: () => RetainedOperation<void>;
  relinquish: () => void;
  complete: () => void;
}): SqliteStagingOwnedToken {
  let tokenCloseService: (() => void) | undefined;
  let tokenClosing: RetainedOperation<void> | undefined;
  const { input, preparationId } = options;
  const owned: SqliteStagingOwnedToken = {
    kind: "token",
    directory: input.directory,
    identity: input.identity,
    mode: input.mode,
    preparationId,
    admitted: false,
    unavailable: false,
    token: Object.freeze({
      identity: input.identity,
      isCurrent: () => {
        try {
          options.task()?.service();
        } catch {
          owned.unavailable = true;
          return false;
        }
        const native = options.nativeDirectory();
        return (
          owned.admitted &&
          !owned.unavailable &&
          !owned.intent &&
          !owned.terminal &&
          !options.isAdmissionClosed() &&
          native?.owner === options.originalNativeOwner() &&
          native?.owner.disposed === false
        );
      },
      retire: () => startTokenSettlement("retire").result,
      close: () => startTokenSettlement("close").result,
    }),
    startSettlement: (intent) => startTokenSettlement(intent),
    serviceClose: () => tokenCloseService?.(),
  };
  function startTokenSettlement(intent: "retire" | "close"): RetainedOperation<void> {
    if (intent === "retire" && (owned.intent === "close" || owned.terminal === "closed")) {
      const refused = createRetainedOperation<void>(() => {});
      refused.reject(
        new SqliteSnapshotCleanupError("SQLite staging token was closed without retirement"),
      );
      return refused.operation;
    }
    if (tokenClosing?.read().status === "pending" || tokenClosing?.read().status === "fulfilled") {
      return tokenClosing;
    }
    // A failed retirement may be explicitly abandoned after ENOENT. Such a close
    // never supplies deletion authority and cannot later become a retirement.
    owned.intent = intent;
    owned.unavailable = true;
    options.requestClose();
    let cleanup: RetainedOperation<void> | undefined;
    let rawRelease: RetainedOperation<void> | undefined;
    let idle: RetainedOperation<void> | undefined;
    let relinquished = false;
    let servicingToken = false;
    const completion = createRetainedOperation<void>(() =>
      options.inContext(() => {
        if (
          options.isAdmitting() ||
          servicingToken ||
          completion.operation.read().status !== "pending"
        ) {
          return;
        }
        servicingToken = true;
        try {
          const task = options.task();
          task?.service();
          options.serviceAdmission();
          if (task?.read().status === "pending") {
            return;
          }
          if (!relinquished) {
            if (options.isInputPrepared() && !owned.terminal) {
              if (!cleanup) {
                cleanup = options.startCloseResource();
                void cleanup.result.then(serviceTokenClose, serviceTokenClose);
              }
              cleanup.service();
              const outcome = cleanup.read();
              if (outcome.status === "pending") {
                return;
              }
              if (outcome.status === "rejected") {
                throw outcome.error;
              }
              if (!owned.terminal) {
                if (options.originalNativeOwner() || options.nativeDirectory()) {
                  throw new SqliteSnapshotCleanupError(
                    "SQLite staging token cleanup has no original native receipt",
                  );
                }
                // A joined original task with no reservation cannot have dispatched token SQL.
                owned.terminal = "not-started";
              }
            } else if (!options.isInputPrepared()) {
              owned.terminal = "not-started";
            }
            if (intent === "retire" && owned.terminal === "closed") {
              throw new SqliteSnapshotCleanupError(
                "SQLite staging token closed without the requested retirement",
              );
            }
            if (task) {
              if (!rawRelease) {
                rawRelease = task.release();
                void rawRelease.result.then(serviceTokenClose, serviceTokenClose);
              }
              rawRelease.service();
              const released = rawRelease.read();
              if (released.status === "pending") {
                return;
              }
              if (released.status === "rejected") {
                throw released.error;
              }
            }
            options.relinquish();
            relinquished = true;
          }
          if (!idle) {
            idle = options.closeWhenIdle();
            void idle.result.then(serviceTokenClose, serviceTokenClose);
          }
          idle.service();
          const closed = idle.read();
          if (closed.status === "pending") {
            return;
          }
          if (closed.status === "rejected") {
            throw closed.error;
          }
          options.complete();
          completion.resolve(undefined);
        } catch (error) {
          completion.reject(normalizeTokenCleanupError(error));
        } finally {
          servicingToken = false;
        }
      }),
    );
    const serviceTokenClose = completion.operation.service.bind(completion.operation);
    tokenCloseService = serviceTokenClose;
    tokenClosing = completion.operation;
    const task = options.task();
    if (task) {
      void task.result.then(serviceTokenClose, serviceTokenClose);
    }
    void options.admissionResult.then(serviceTokenClose, serviceTokenClose);
    completion.operation.service();
    return tokenClosing;
  }

  return owned;
}

/** Capture filesystem identity before handing native admission to the existing owner. */
export function startTokenAdmission(
  captureOwner: () => {
    start(input: SqliteSnapshotStagingInput, signal?: AbortSignal): SqliteSnapshotStagingRequest;
  },
  directory: string,
  mode: "create" | "reclaim",
  options: {
    signal?: AbortSignal;
    expectedDirectoryIdentity?: SqliteStagingTokenIdentity["directory"];
  } = {},
): WorkerOwnedSqliteStagingTokenAdmission {
  options.signal?.throwIfAborted();
  const absoluteDirectory = path.resolve(directory);
  const identity = captureSqliteStagingTokenIdentity(
    absoluteDirectory,
    mode,
    options.expectedDirectoryIdentity,
  );
  let request: SqliteSnapshotStagingRequest;
  try {
    const { env, cwd } = captureSqliteReadOnlyWorkerLaunch();
    const owner = captureOwner();
    request = owner.start(
      {
        type: "token",
        directory: absoluteDirectory,
        mode,
        identity,
        launch: { env, cwd, transport: { kind: "native" } },
      },
      options.signal,
    );
  } catch (error) {
    // start() throws only before returning original task custody or native dispatch.
    const rejected = createRetainedOperation<WorkerOwnedSqliteStagingToken>(() => {});
    rejected.reject(error);
    const close = () => {
      const joined = createRetainedOperation<void>(() => {});
      joined.resolve(undefined);
      return joined.operation;
    };
    return { ...rejected.operation, identity, startClose: close, startRelease: close };
  }
  const admitted = mapRetainedOperation(request, (reply) => {
    if (
      reply.type !== "token" ||
      !sameTokenIdentity(identity, readSqliteStagingTokenIdentity(reply.identity))
    ) {
      throw new SqliteSnapshotCleanupError("SQLite staging admission returned a different token");
    }
    if (!request.token) {
      throw new SqliteSnapshotCleanupError("SQLite token admission lost its original capability");
    }
    return request.token;
  });
  return {
    ...admitted,
    identity,
    startClose: () => request.startClose(),
    startRelease: () => {
      if (!request.startRelease) {
        throw new SqliteSnapshotCleanupError(
          "SQLite token admission lost its non-destructive cleanup capability",
        );
      }
      return request.startRelease();
    },
  };
}
