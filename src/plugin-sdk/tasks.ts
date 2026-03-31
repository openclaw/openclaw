import { defaultTaskOperationsRuntime } from "../../packages/tasks-host-sdk/src/runtime-core.js";
import { startTaskRegistryMaintenance } from "../../packages/tasks-host-sdk/src/runtime-core.js";
import type { OpenClawPluginService } from "../plugins/types.js";

export * from "../../packages/tasks-host-sdk/src/runtime-core.js";

export const defaultOperationsRuntime = defaultTaskOperationsRuntime;

export function createDefaultOperationsMaintenanceService(): OpenClawPluginService {
  return {
    id: "default-operations-maintenance",
    start() {
      startTaskRegistryMaintenance();
    },
  };
}
