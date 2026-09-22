import { ensureSqliteLibrarySelected } from "../infra/bun-sqlite-library.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import {
  DEFAULT_WORKER_PENDING_BYTES,
  DEFAULT_WORKER_PENDING_TASKS,
} from "../infra/worker-task-capacity.js";
import { createOwnedWorkerTaskPool, WorkerTaskError } from "../infra/worker-task-pool.js";
import type { OwnedWorkerTask } from "../infra/worker-task-pool.types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  registerOpenClawStateDatabaseAsyncResource,
  registerOpenClawStateDatabaseLifecycleListener,
} from "./openclaw-state-db-cache.js";
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
      phase: "after-resources",
      async close(identity) {
        if (!owned.pool) {
          return;
        }
        const pool = owned.pool;
        if (identity) {
          await pool.closeResources(identity.key);
          return;
        }
        await (owned.closing ??= Promise.resolve()
          .then(() => pool.closeResources())
          .then(() => pool.close())
          .then(() => {
            owned.pool = undefined;
          })
          .finally(() => {
            owned.closing = undefined;
          }));
      },
    });
    registerOpenClawStateDatabaseLifecycleListener((event) => {
      if (event.kind !== "opened" && event.identity) {
        void owned.pool?.closeResources(event.identity.key).catch((error: unknown) => {
          // The worker retains failed cleanup; canonical path close retries it.
          process.emitWarning(`Shared-state reader invalidation failed: ${String(error)}`);
        });
      }
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
      workerOptions: { resourceLimits: { maxOldGenerationSizeMb: 512 } },
      maxWorkers: 2,
      idleTimeoutMs: SQLITE_IDLE_HANDLE_TTL_MS,
      maxPendingTasks: DEFAULT_WORKER_PENDING_TASKS,
      maxPendingBytes: DEFAULT_WORKER_PENDING_BYTES,
    });
  }
  return state.pool;
}

function captureCommand(command: OpenClawStateReadCommand): OpenClawStateReadCommand {
  if (command.type === "mcpOAuth.statuses") {
    return { type: command.type, input: [...command.input] };
  }
  if (command.type === "conversationBindings.inspect") {
    const { channel, accountId, conversationId, parentConversationId } = command.conversation;
    return {
      type: command.type,
      conversation: {
        channel,
        accountId,
        conversationId,
        ...(parentConversationId !== undefined ? { parentConversationId } : {}),
      },
    };
  }
  if (command.type === "cron.observeRunRecovery") {
    return {
      type: command.type,
      storeKey: command.storeKey,
      proposals: command.proposals.map(({ jobId, queuedAtMs, runningAtMs }) => ({
        jobId,
        ...(queuedAtMs === undefined ? {} : { queuedAtMs }),
        ...(runningAtMs === undefined ? {} : { runningAtMs }),
      })),
    };
  }
  if (command.type === "devicePairing.bootstrapContext") {
    return { ...command, input: { ...command.input } };
  }
  if (command.type === "operatorApprovals.history") {
    return { ...command, input: { ...command.input } };
  }
  if (command.type === "pluginBlob.lookup") {
    const { pluginId, namespace, key } = command.input;
    return { type: command.type, input: { pluginId, namespace, key } };
  }
  if (command.type === "pluginBlob.entries") {
    const { pluginId, namespace } = command.input;
    return { type: command.type, input: { pluginId, namespace } };
  }
  if (command.type === "updateRuns.list") {
    return { ...command, input: { ...command.input } };
  }
  if (
    command.type === "skills.library.descriptions" ||
    command.type === "skills.library.manifests"
  ) {
    return {
      type: command.type,
      input: command.input.map(({ skillId, revision }) => ({ skillId, revision })),
    };
  }
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
  if (command.type === "workers.placementProjection") {
    return structuredClone(command);
  }
  if (command.type === "workerEnvironments.pruneCandidates") {
    return {
      type: command.type,
      input: {
        ...command.input,
        cursor: command.input.cursor ? { ...command.input.cursor } : undefined,
      },
    };
  }
  if (command.type === "workerEnvironments.snapshot") {
    return { type: command.type, ...(command.ids ? { ids: [...command.ids] } : {}) };
  }
  return { ...command };
}

function commandBytes(command: OpenClawStateReadRequest["command"]): number {
  let bytes = Buffer.byteLength(command.type, "utf8");
  if (command.type === "mcpOAuth.statuses") {
    return command.input.reduce((total, key) => total + Buffer.byteLength(key, "utf8"), bytes);
  }
  if (
    command.type === "mcpOAuth.readOnly" ||
    command.type === "mcpOAuth.keys" ||
    command.type === "mcpOAuth.pending" ||
    command.type === "mcpOAuth.countPrincipals"
  ) {
    return bytes + Buffer.byteLength(command.input, "utf8");
  }
  if (command.type === "conversationBindings.inspect") {
    return (
      bytes +
      Object.values(command.conversation).reduce(
        (sum, value) => sum + Buffer.byteLength(value ?? "", "utf8"),
        0,
      )
    );
  }
  if (command.type === "cron.observeRunRecovery") {
    return command.proposals.reduce(
      (total, proposal) =>
        total +
        Buffer.byteLength(proposal.jobId, "utf8") +
        (proposal.queuedAtMs === undefined ? 0 : 8) +
        (proposal.runningAtMs === undefined ? 0 : 8),
      bytes + Buffer.byteLength(command.storeKey, "utf8"),
    );
  }
  if (command.type === "devicePairing.bootstrapContext") {
    return (
      bytes +
      Buffer.byteLength(command.input.token) +
      Buffer.byteLength(command.input.deviceId) +
      Buffer.byteLength(command.input.publicKey) +
      8
    );
  }
  if (command.type === "devicePairing.lookup") {
    return bytes + Buffer.byteLength(command.deviceId);
  }
  if (command.type === "devicePairing.pending") {
    return bytes + Buffer.byteLength(command.requestId) + 8;
  }
  if (command.type === "devicePairing.list") {
    return bytes + 8 + Buffer.byteLength(command.publishedRevision ?? "");
  }
  if (command.type === "operatorApprovals.history") {
    return (
      bytes +
      Buffer.byteLength(command.input.cursor ?? "", "utf8") +
      Buffer.byteLength(command.input.kind ?? "", "utf8") +
      16
    );
  }
  if (command.type === "pluginBlob.lookup" || command.type === "pluginBlob.entries") {
    return (
      bytes +
      Buffer.byteLength(command.input.pluginId, "utf8") +
      Buffer.byteLength(command.input.namespace, "utf8") +
      (command.type === "pluginBlob.lookup" ? Buffer.byteLength(command.input.key, "utf8") : 0)
    );
  }
  if (command.type === "sandboxRegistry.get") {
    return bytes + Buffer.byteLength(command.containerName, "utf8");
  }
  if (command.type === "sandboxRegistry.runtimeIds") {
    return (
      bytes +
      Buffer.byteLength(command.backendId, "utf8") +
      Buffer.byteLength(command.scopeKey, "utf8")
    );
  }
  if (command.type === "updateRuns.get") {
    return bytes + Buffer.byteLength(command.runId, "utf8");
  }
  if (command.type === "updateRuns.list") {
    return (
      bytes +
      Buffer.byteLength(command.input.reason ?? "", "utf8") +
      Buffer.byteLength(command.input.includeRunId ?? "", "utf8") +
      (command.input.limit === undefined ? 0 : 8) +
      (command.input.active === undefined ? 0 : 1)
    );
  }
  if (
    command.type === "skills.library.descriptions" ||
    command.type === "skills.library.manifests"
  ) {
    return command.input.reduce(
      (total, pin) =>
        total + Buffer.byteLength(pin.skillId, "utf8") + Buffer.byteLength(pin.revision, "utf8"),
      bytes,
    );
  }
  if (command.type === "fleet.get") {
    return bytes + Buffer.byteLength(command.tenantId, "utf8");
  }
  if (command.type === "onboardingRecommendations.read") {
    return bytes + Buffer.byteLength(command.configKey, "utf8");
  }
  if (command.type === "userProfiles.reconcile") {
    return bytes + Buffer.byteLength(command.profileId, "utf8");
  }
  if (command.type === "userProfiles.email.resolve") {
    return bytes + Buffer.byteLength(command.email, "utf8");
  }
  if (command.type === "workspace.snapshot") {
    return bytes + Buffer.byteLength(command.workspaceDir, "utf8");
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
  if (command.type === "workers.placementProjection") {
    return Buffer.byteLength(JSON.stringify(command), "utf8");
  }
  if (command.type === "workerEnvironments.pruneCandidates") {
    return (
      bytes +
      8 +
      (command.input.limit === undefined ? 0 : 8) +
      (command.input.cursor ? 8 + Buffer.byteLength(command.input.cursor.environmentId, "utf8") : 0)
    );
  }
  if (command.type === "workerEnvironments.snapshot") {
    return (
      bytes + (command.ids?.reduce((total, id) => total + Buffer.byteLength(id, "utf8"), 0) ?? 0)
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
    sourceAdmitted: reply.sourceAdmitted === true,
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
