import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import { SqliteSnapshotCleanupError } from "../infra/sqlite-readonly-location-cleanup.js";
import { prepareSqliteReadOnlyCopyInProcess } from "../infra/sqlite-readonly-location.js";
import type { PreparedSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.types.js";
import type { SqliteReadOnlyOperationContext } from "../infra/sqlite-readonly-operation-types.js";
import type { DatabaseFileIdentity } from "../infra/sqlite-worker-identity.js";
import type { SqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { createStateReadPool } from "./openclaw-state-read-pool.js";
import { requestBytes } from "./openclaw-state-read-request.js";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadReply,
  OpenClawStateReadRequest,
} from "./openclaw-state-read.types.js";

export type StateSnapshotReadInput = {
  stagingRoot: string;
  expectedSourceIdentity: DatabaseFileIdentity;
  command: Extract<OpenClawStateReadCommand, { type: "plugins.metadata.read" }>;
  context: Pick<SqliteWorkerStateContext, "environment" | "existingSchemaPath">;
};

/** The native snapshot child owns copies; its SQL worker owns admission and queries. */
async function readStateSnapshot(
  input: StateSnapshotReadInput,
  context: SqliteReadOnlyOperationContext,
): Promise<OpenClawStateReadReply> {
  const pool = createStateReadPool(resolveRuntimeProcessEntrypointUrl("stateRead"));
  let prepared: PreparedSqliteReadOnlyLocation | undefined;
  const run = async (request: OpenClawStateReadRequest) => {
    const task = pool.runTask(request, {
      inputBytes: requestBytes(request),
      diagnosticOperation: request.command.type,
    });
    const [outcome] = await Promise.allSettled([task.result]);
    const errors: unknown[] = outcome.status === "rejected" ? [outcome.reason] : [];
    try {
      await task.close(
        request.command.type !== "admit" ||
          outcome.status === "rejected" ||
          !outcome.value.ok ||
          Boolean(outcome.value.nativeCleanupFailure)
          ? { retire: true }
          : undefined,
      );
    } catch (error) {
      errors.push(error);
    }
    throwSqliteLifecycleErrors(errors, "Shared-state snapshot task and cleanup failed");
    if (outcome.status === "rejected") {
      throw outcome.reason;
    }
    return outcome.value;
  };
  const read = async () => {
    const request: OpenClawStateReadRequest = {
      context: input.context,
      databasePath: context.path,
      location: context.path,
      checkFreshAdmission: true,
      command: { type: "admit" },
    };
    const admitted = await run(request);
    if (!admitted.ok) {
      return admitted;
    }
    prepared = await prepareSqliteReadOnlyCopyInProcess(
      context.path,
      input.stagingRoot,
      input.expectedSourceIdentity,
    );
    return run({
      ...request,
      location: prepared.location,
      snapshotRoot: prepared.cleanupRoot,
      command: input.command,
    });
  };
  const [outcome] = await Promise.allSettled([read()]);
  const errors: unknown[] = outcome.status === "rejected" ? [outcome.reason] : [];
  let readersClosed = false;
  try {
    await pool.close();
    readersClosed = true;
  } catch (error) {
    errors.push(error);
  }
  // A failed worker close leaves its bytes with the parent's known staging owner.
  if (prepared && readersClosed) {
    try {
      if (!(await prepared.cleanupAsync())) {
        throw new SqliteSnapshotCleanupError("Shared-state snapshot cleanup failed");
      }
    } catch (error) {
      errors.push(error);
    }
  }
  throwSqliteLifecycleErrors(errors, "Shared-state snapshot read and cleanup failed");
  if (outcome.status === "rejected") {
    throw outcome.reason;
  }
  return outcome.value;
}

export const stateSnapshotReadOperations = { "stateSnapshot.read": readStateSnapshot };
