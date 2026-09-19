import { ensureSqliteLibrarySelected } from "../infra/bun-sqlite-library.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import {
  DEFAULT_WORKER_PENDING_BYTES,
  DEFAULT_WORKER_PENDING_TASKS,
} from "../infra/worker-task-capacity.js";
import { createOwnedWorkerTaskPool, WorkerTaskError } from "../infra/worker-task-pool.js";
import type { OwnedWorkerTask } from "../infra/worker-task-pool.types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { registerOpenClawStateDatabaseAsyncResource } from "./openclaw-state-db-cache.js";
import type {
  OpenClawStateReadAuthority,
  OpenClawStateReadCommand,
  OpenClawStateReadLocation,
  OpenClawStateReadOutcome,
  OpenClawStateReadReply,
  OpenClawStateReadRequest,
} from "./openclaw-state-read.types.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "./openclaw-state-worker-error.js";

type ReadPool = ReturnType<
  typeof createOwnedWorkerTaskPool<OpenClawStateReadRequest, OpenClawStateReadReply>
>;
type ReadRuntime = { pool?: ReadPool; closing?: Promise<void> };

function readPool(): ReadPool {
  const state = resolveGlobalSingleton<ReadRuntime>(Symbol.for("openclaw.stateReadWorkers"), () => {
    const owned: ReadRuntime = {};
    registerOpenClawStateDatabaseAsyncResource({
      async close(identity) {
        // Per-path retirement closes only that path's operation handles. Idle workers own no DB.
        if (identity || !owned.pool) {
          return;
        }
        const pool = owned.pool;
        await (owned.closing ??= Promise.resolve()
          .then(() => pool.close())
          .then(() => {
            owned.pool = undefined;
          })
          .finally(() => {
            owned.closing = undefined;
          }));
      },
    });
    return owned;
  });
  if (state.closing) {
    throw new WorkerTaskError("Shared-state readers are closing", "unavailable");
  }
  if (!state.pool) {
    // Publish Bun's process-wide selection before any worker can load SQLite.
    ensureSqliteLibrarySelected();
    state.pool = createOwnedWorkerTaskPool({
      workerUrl: resolveRuntimeProcessEntrypointUrl("stateRead"),
      maxWorkers: 2,
      maxPendingTasks: DEFAULT_WORKER_PENDING_TASKS,
      maxPendingBytes: DEFAULT_WORKER_PENDING_BYTES,
    });
  }
  return state.pool;
}

function captureCommand(command: OpenClawStateReadCommand): OpenClawStateReadCommand {
  if (command.type === "audit.run.inspect") {
    const input = command.input;
    const common = {
      now: input.now,
      decisionCursor: input.decisionCursor,
      decisionLimit: input.decisionLimit,
    };
    return {
      type: command.type,
      input:
        "executionId" in input
          ? { ...common, executionId: input.executionId }
          : {
              ...common,
              runId: input.runId,
              executionOffset: input.executionOffset,
              executionLimit: input.executionLimit,
            },
    };
  }
  return command.type === "fleet.get"
    ? { type: command.type, tenantId: command.tenantId }
    : { type: command.type };
}

function commandBytes(command: OpenClawStateReadRequest["command"]): number {
  let bytes = Buffer.byteLength(command.type, "utf8");
  if (command.type === "fleet.get") {
    return bytes + Buffer.byteLength(command.tenantId, "utf8");
  }
  if (command.type === "audit.run.inspect") {
    const input = command.input;
    // Each supplied numeric scalar retains one eight-byte JavaScript number.
    bytes += Buffer.byteLength(input.decisionCursor ?? "", "utf8") + 8;
    if (input.decisionLimit !== undefined) {
      bytes += 8;
    }
    if ("executionId" in input) {
      return bytes + Buffer.byteLength(input.executionId, "utf8");
    }
    return (
      bytes +
      Buffer.byteLength(input.runId, "utf8") +
      (input.executionOffset === undefined ? 0 : 8) +
      (input.executionLimit === undefined ? 0 : 8)
    );
  }
  return bytes;
}

function requestBytes(request: OpenClawStateReadRequest): number {
  return [
    ...Object.values(request.context.environment),
    request.context.coordinatorRuntime.directory,
    request.context.existingSchemaPath,
    request.databasePath,
    request.location,
    request.expectedIdentity,
    request.snapshotRoot,
  ].reduce(
    (bytes, value) => bytes + (value === undefined ? 0 : Buffer.byteLength(value, "utf8")),
    commandBytes(request.command),
  );
}

function decodeTaskReply(reply: OpenClawStateReadReply): OpenClawStateReadOutcome {
  if (reply.ok) {
    return { value: reply };
  }
  const error = new Error(reply.message);
  retainOpenClawStateWorkerErrorPayload(error, reply.error);
  return {
    error: hydrateOpenClawStateWorkerError(error, { includeOrdinary: true }),
    sourceAdmitted: reply.sourceAdmitted,
  };
}

export function createOpenClawStateReadTransport(command: OpenClawStateReadCommand) {
  // Capture nested input before the read owner can yield during snapshot preparation.
  const capturedCommand = captureCommand(command);
  const tasks = new Map<
    OwnedWorkerTask<OpenClawStateReadReply>,
    { retire: boolean; error?: Error }
  >();
  let closed = false;
  let closing: Promise<void> | undefined;
  const closeTask = async (task: OwnedWorkerTask<OpenClawStateReadReply>) => {
    const cleanup = tasks.get(task);
    try {
      await task.close(cleanup?.retire ? { retire: true } : undefined);
    } catch (error) {
      if (cleanup?.error) {
        throw createSqliteLifecycleAggregateError(
          [cleanup.error, error],
          "Shared-state reader cleanup and worker retirement failed",
          cleanup.error,
        );
      }
      throw error;
    }
    tasks.delete(task);
  };
  const run = async (
    context: OpenClawStateWorkerContext,
    location: string,
    checkFreshAdmission: boolean,
    operation: OpenClawStateReadRequest["command"],
    authority: OpenClawStateReadAuthority,
    expectedIdentity?: string,
    snapshotRoot?: string,
  ) => {
    if (closed) {
      throw new WorkerTaskError("Shared-state read transport is closed", "unavailable");
    }
    authority.assertCurrent();
    const request: OpenClawStateReadRequest = {
      context: {
        environment: { ...context.environment },
        coordinatorRuntime: { ...context.coordinatorRuntime },
        existingSchemaPath: context.existingSchemaPath,
      },
      databasePath: context.admission.databasePath,
      location,
      checkFreshAdmission,
      expectedIdentity,
      snapshotRoot,
      command: { ...operation },
    };
    const task = readPool().runTask(
      () => {
        authority.assertCurrent();
        return request;
      },
      { signal: authority.signal, inputBytes: requestBytes(request) },
    );
    const cleanup: { retire: boolean; error?: Error } = { retire: true };
    tasks.set(task, cleanup);
    let outcome: OpenClawStateReadOutcome;
    try {
      const reply = await task.result;
      if (reply.nativeCleanupFailure) {
        const error = new Error("Quarantine reader native cleanup was not confirmed");
        retainOpenClawStateWorkerErrorPayload(error, reply.nativeCleanupFailure.error);
        cleanup.error = hydrateOpenClawStateWorkerError(error, { includeOrdinary: true });
      }
      outcome = decodeTaskReply(reply);
    } catch (error) {
      outcome = { error };
    }
    // Best-effort quarantine failures can require retirement even when the domain read succeeds.
    // Bun retains native statements after close; thread exit remains its disposal boundary.
    cleanup.retire =
      Boolean(process.versions.bun) || "error" in outcome || cleanup.error !== undefined;
    return { task, outcome };
  };
  return {
    async validateFresh(
      context: OpenClawStateWorkerContext,
      authority: OpenClawStateReadAuthority,
    ) {
      const { task, outcome } = await run(
        context,
        context.admission.databasePath,
        true,
        { type: "admit" },
        authority,
      );
      if ("error" in outcome) {
        throw outcome.error;
      }
      authority.assertCurrent();
      await closeTask(task);
    },
    async read(source: OpenClawStateReadLocation, authority: OpenClawStateReadAuthority) {
      const { outcome } = await run(
        source.context,
        source.location,
        source.checkFreshAdmission,
        capturedCommand,
        authority,
        source.expectedIdentity,
        source.snapshotRoot,
      );
      return outcome;
    },
    close(): Promise<void> {
      closed = true;
      return (closing ??= Promise.allSettled([...tasks.keys()].map(closeTask))
        .then((results) => {
          const errors = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (errors.length === 1) {
            throw errors[0];
          }
          if (errors.length > 1) {
            throw new AggregateError(errors, "Shared-state reader task cleanup failed");
          }
        })
        .finally(() => {
          closing = undefined;
        }));
    },
  };
}
