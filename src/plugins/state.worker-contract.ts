import type { WorkerOperations } from "../state/worker-operation-registry.js";
import type { pluginRuntimeOperations } from "./state.worker.js";

export type PluginRuntimeWorkerOperations = WorkerOperations<typeof pluginRuntimeOperations>;
