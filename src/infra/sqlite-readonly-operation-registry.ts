import type { AgentDeletionSessionStoreAbsentReadOperations } from "../agents/agent-delete-session-store-safety.worker-contract.js";
import type { stateSnapshotReadOperations } from "../state/openclaw-state-read-snapshot.js";
import {
  createWorkerOperationRegistry,
  type WorkerOperations,
} from "../state/worker-operation-registry.js";
import type { immutableInstallReadOperations } from "./package-update-activation-immutable.js";
import type { pageCacheReadOperations } from "./sqlite-page-cache.worker.js";
import type { SqliteReadOnlyOperationContext } from "./sqlite-readonly-operation-types.js";

export type SqliteReadOnlyOperations = WorkerOperations<
  typeof immutableInstallReadOperations &
    typeof pageCacheReadOperations &
    typeof stateSnapshotReadOperations
> &
  AgentDeletionSessionStoreAbsentReadOperations;

export const sqliteReadOnlyOperations = createWorkerOperationRegistry<
  SqliteReadOnlyOperations,
  SqliteReadOnlyOperationContext
>({
  agentRetirement: () =>
    import("../agents/agent-delete-session-store-safety.kernel.js").then(
      (module) => module.agentDeletionSessionStoreAbsentReadOperations,
    ),
  pageCache: () =>
    import("./sqlite-page-cache.worker.js").then((module) => module.pageCacheReadOperations),
  immutableInstall: () =>
    import("./package-update-activation-immutable.js").then(
      (module) => module.immutableInstallReadOperations,
    ),
  stateSnapshot: () =>
    import("../state/openclaw-state-read-snapshot.js").then(
      (module) => module.stateSnapshotReadOperations,
    ),
});
