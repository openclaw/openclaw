import type { AgentDeletionSessionStoreAbsentReadOperations } from "../agents/agent-delete-session-store-safety.worker-contract.js";
import type { startupMetadataLiveReadOperations } from "../state/startup-metadata-live-read.worker.js";
import {
  createWorkerOperationRegistry,
  type WorkerOperations,
} from "../state/worker-operation-registry.js";
import type { DeferredSessionTranscriptReadOperations } from "./deferred-plugin-session-source-recovery.worker-contract.js";
import type { immutableInstallReadOperations } from "./package-update-activation-immutable.js";
import type { pageCacheReadOperations } from "./sqlite-page-cache.worker.js";
import type { SqliteReadOnlyOperationContext } from "./sqlite-readonly-operation-types.js";

export type SqliteReadOnlyOperations = WorkerOperations<
  typeof immutableInstallReadOperations &
    typeof pageCacheReadOperations &
    typeof startupMetadataLiveReadOperations
> &
  DeferredSessionTranscriptReadOperations &
  AgentDeletionSessionStoreAbsentReadOperations;

export const sqliteReadOnlyOperations = createWorkerOperationRegistry<
  SqliteReadOnlyOperations,
  SqliteReadOnlyOperationContext
>({
  startupMetadata: () =>
    import("../state/startup-metadata-live-read.worker.js").then(
      (module) => module.startupMetadataLiveReadOperations,
    ),
  deferredSessionImport: () =>
    import("./deferred-plugin-session-transcript-read.worker.js").then(
      (module) => module.deferredSessionTranscriptReadOperations,
    ),
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
});
