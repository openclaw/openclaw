import type { AgentDeletionSessionStoreAbsentReadOperations } from "../agents/agent-delete-session-store-safety.worker-contract.js";
import type { startupMetadataReadOperations } from "../state/startup-metadata-live-read.worker.js";
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
    typeof startupMetadataReadOperations
> &
  DeferredSessionTranscriptReadOperations &
  AgentDeletionSessionStoreAbsentReadOperations;

const sqliteReadOnlyOperationProcessLifecycle = {
  // This read can borrow host-side schema maintenance. The pooled child transport
  // has process-lifetime admission, so its native exit is the release boundary.
  "startupMetadata.readCurrent": "retire-after-result",
} as const satisfies Partial<Record<keyof SqliteReadOnlyOperations, "retire-after-result">>;

export function sqliteReadOnlyOperationRequiresProcessRetirement(type: string): boolean {
  return type in sqliteReadOnlyOperationProcessLifecycle;
}

export const sqliteReadOnlyOperations = createWorkerOperationRegistry<
  SqliteReadOnlyOperations,
  SqliteReadOnlyOperationContext
>({
  startupMetadata: () =>
    import("../state/startup-metadata-live-read.worker.js").then(
      (module) => module.startupMetadataReadOperations,
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
