// Test runtime helpers for task registry state and deterministic cleanup.
import { getTaskFlowRegistryStore } from "../tasks/task-flow-registry.store.js";
import { configureTaskRegistryRuntime } from "../tasks/task-registry.store.js";
import { createInMemoryTaskRegistryStore } from "./task-registry-store.js";

/** Installs an in-memory task registry store for tests that avoid disk state. */
export function installInMemoryTaskRegistryRuntime() {
  const taskStore = createInMemoryTaskRegistryStore(undefined, getTaskFlowRegistryStore());
  configureTaskRegistryRuntime({ store: taskStore });
  return { taskStore };
}
