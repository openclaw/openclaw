// Internal task registry facade used by runtime modules without exposing public SDK surface.
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  ensureTaskFlowRegistryReadyAsync,
  reloadTaskFlowRegistryFromStoreAsync,
} from "./task-flow-runtime-internal.js";
import {
  ensureTaskRegistryReadyAsync,
  reloadTaskRegistryFromStoreAsync,
} from "./task-registry-state.js";
import type { TaskRecord } from "./task-registry.types.js";

/** Read a task view without creating state or refreshing the synchronous projections. */
export async function findTaskViewByRunIdAsync(
  runId: string,
  assertCurrent: () => void,
): Promise<TaskRecord | undefined> {
  assertCurrent();
  const lookup = runId.trim();
  if (!lookup) {
    return undefined;
  }
  const context = captureOpenClawStateWorkerContext();
  const { runOpenClawStateWorkerOperation } =
    await import("../state/openclaw-state-worker-store.js");
  const task = await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "tasks.findByRunId", input: { runId: lookup } }),
    { existingOnly: true, assertCurrent },
  );
  context.admission.assertCurrent();
  assertCurrent();
  return task;
}

export async function ensureTaskRuntimeStateReady(): Promise<void> {
  const context = captureOpenClawStateWorkerContext();
  await ensureTaskFlowRegistryReadyAsync(context);
  context.admission.assertCurrent();
  await ensureTaskRegistryReadyAsync(context);
}

export async function reloadTaskRuntimeStateFromStore(): Promise<void> {
  const context = captureOpenClawStateWorkerContext();
  await reloadTaskFlowRegistryFromStoreAsync(context);
  context.admission.assertCurrent();
  await reloadTaskRegistryFromStoreAsync(context);
}

export {
  assertTaskCancellationReadyById,
  cancelTaskById,
  createTaskRecord,
  deleteTaskRecordById,
  ensureTaskRegistryReady,
  findTaskByRunId,
  finalizeTaskRecordByRunId,
  getTaskById,
  hasActiveTaskForChildSessionKey,
  listFreshTasksForOwnerKey,
  listTaskRecordPage,
  listTaskRecords,
  listTaskRecordsForOwnerTree,
  listTasksForFlowId,
  listTasksForOwnerKey,
  linkTaskToFlowById,
  markTaskLostById,
  markTaskRunningByRunId,
  markTaskTerminalById,
  maybeDeliverTaskTerminalUpdate,
  publishTaskRecordAfterAtomicStore,
  recordTaskProgressByRunId,
  resolveTaskForLookupToken,
  isParentFlowLinkError,
  setTaskCleanupAfterById,
  setTaskRunDeliveryStatusByRunId,
  updateTaskNotifyPolicyById,
} from "./task-registry.js";
export type { TaskRecord } from "./task-registry.types.js";
export { listTaskStatesForFlowIds } from "./task-registry-query.js";
export {
  createTaskRegistryReadPreparation,
  prepareTaskRegistryRead,
} from "./task-registry-read.js";
