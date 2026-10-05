import type { createPluginModelCatalogReadOperations } from "../agents/plugin-model-catalog.read-operation.js";
import {
  createWorkerOperationRegistry,
  type WorkerOperations,
} from "../state/worker-operation-registry.js";
import type { trajectoryRuntimeRetentionReadOperations } from "../trajectory/runtime-retention.worker.js";
import type { immutableInstallReadOperations } from "./package-update-activation-immutable.js";
import type { SqliteReadOnlyOperationContext } from "./sqlite-readonly-operation-types.js";

export type SqliteReadOnlyOperations = WorkerOperations<
  ReturnType<typeof createPluginModelCatalogReadOperations> &
    typeof immutableInstallReadOperations &
    typeof trajectoryRuntimeRetentionReadOperations
>;

export const sqliteReadOnlyOperations = createWorkerOperationRegistry<
  SqliteReadOnlyOperations,
  SqliteReadOnlyOperationContext
>({
  trajectoryRetention: () =>
    import("../trajectory/runtime-retention.worker.js").then(
      (module) => module.trajectoryRuntimeRetentionReadOperations,
    ),
  pluginCatalog: () =>
    import("../agents/plugin-model-catalog.kernel.js").then(
      (module) => module.pluginModelCatalogReadOperations,
    ),
  immutableInstall: () =>
    import("./package-update-activation-immutable.js").then(
      (module) => module.immutableInstallReadOperations,
    ),
});
