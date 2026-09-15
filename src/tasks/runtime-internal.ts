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
  listTaskRecordsUnsorted,
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
