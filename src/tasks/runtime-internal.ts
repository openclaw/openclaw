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

export function createPluginTaskRecord(
  params: Parameters<typeof createTaskRecordInRegistry>[0],
): ReturnType<typeof createTaskRecordInRegistry> {
  return createTaskRecordInRegistry(params);
}
