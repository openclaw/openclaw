import type { OpenClawPluginService } from "../plugins/types.js";
import { defaultTaskOperationsRuntime } from "../tasks/operations-runtime.js";
import { startTaskRegistryMaintenance } from "../tasks/task-registry.maintenance.js";

export const defaultOperationsRuntime = defaultTaskOperationsRuntime;

export function createDefaultOperationsMaintenanceService(): OpenClawPluginService {
  return {
    id: "default-operations-maintenance",
    start() {
      startTaskRegistryMaintenance();
    },
  };
}
