import { expect } from "vitest";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createInMemoryTaskRegistryStore } from "../test-utils/task-registry-store.js";
import { listTaskRecordPage } from "./task-registry-query.js";
import { configureTaskRegistryRuntime, getTaskRegistryStore } from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";

export function configureTaskSnapshot(tasks: Iterable<TaskRecord>) {
  const snapshotTasks = new Map([...tasks].map((task) => [task.taskId, task]));
  const store = createInMemoryTaskRegistryStore({
    tasks: snapshotTasks,
    deliveryStates: new Map(),
  });
  configureTaskRegistryRuntime({ store });
  return store;
}

export function captureTaskPageRead() {
  return { readContext: captureOpenClawStateWorkerContext(), store: getTaskRegistryStore() };
}

export async function readTaskPage(
  params: Omit<Parameters<typeof listTaskRecordPage>[0], "readContext" | "store">,
  read = captureTaskPageRead(),
) {
  const result = await listTaskRecordPage({ ...params, ...read });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`task page failed: ${result.error}`);
  }
  return result.value;
}
