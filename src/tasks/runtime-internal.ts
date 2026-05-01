// Internal task registry facade used by runtime modules without exposing public SDK surface.
import { createTaskRecord as createTaskRecordInRegistry } from "./task-registry.js";
export {
  cancelTaskById,
  createTaskRecord,
  deleteTaskRecordById,
  ensureTaskRegistryReady,
  finalizeTaskRunById,
  resetTaskRegistryControlRuntimeForTests,
  findLatestTaskForFlowId,
  finalizeTaskRunByRunId,
  getTaskById,
  hasActiveTaskForChildSessionKey,
  listFreshTasksForOwnerKey,
  listTaskRecords,
  listTasksForFlowId,
  listTasksForOwnerKey,
  linkTaskToFlowById,
  markTaskLostById,
  markTaskRunningById,
  markTaskRunningByRunId,
  markTaskTerminalById,
  maybeDeliverTaskTerminalUpdate,
  recordTaskProgressById,
  recordTaskProgressByRunId,
  reloadTaskRegistryFromStore,
  resetTaskRegistryDeliveryRuntimeForTests,
  resolveTaskForLookupToken,
  resetTaskRegistryForTests,
  isParentFlowLinkError,
  setTaskRegistryControlRuntimeForTests,
  setTaskRegistryDeliveryRuntimeForTests,
  setTaskCleanupAfterById,
  setTaskRunDeliveryStatusByRunId,
  updateTaskNotifyPolicyById,
} from "./task-registry.js";
export type { TaskRecord } from "./task-registry.types.js";

export function createPluginTaskRecord(
  params: Parameters<typeof createTaskRecordInRegistry>[0],
): ReturnType<typeof createTaskRecordInRegistry> {
  return createTaskRecordInRegistry(params);
}
