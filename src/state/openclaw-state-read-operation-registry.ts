import { worktreeReadOperations } from "../agents/worktrees/registry-read.kernel.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { sessionUpstreamReadOperations } from "../sessions/session-upstream-links.kernel.js";
import {
  createWorkerOperationRegistry,
  type WorkerOperationsFromLoaders,
} from "./worker-operation-registry.js";

const loaders = {
  agentProvenance: () =>
    import("./agent-provenance.kernel.js").then((m) => m.agentProvenanceReadOperations),
  managedImages: () =>
    import("../gateway/managed-image-record-store.kernel.js").then(
      (m) => m.managedImageRecordReadOperations,
    ),
  githubPublications: () =>
    import("./github-publication.read.worker.js").then((m) => m.publicationReadOperations),
  deviceIdentity: () =>
    import("../infra/device-identity.read.worker.js").then((m) => m.deviceIdentityReadOperations),
  stateBootstrap: () =>
    import("./state-bootstrap-read.worker.js").then((m) => m.stateBootstrapReadOperations),
  machineState: () =>
    import("./config-machine-state.read.worker.js").then((m) => m.machineStateReadOperations),
  projects: () =>
    import("../projects/project-registry.kernel.js").then((m) => m.projectRegistryReadOperations),
  // Cleanup-state reads already require this kernel in the same read-worker graph.
  worktrees: async () => worktreeReadOperations,
  agentDeletion: () =>
    import("../agents/agent-delete-session-store-safety.kernel.js").then(
      (m) => m.agentDeletionSessionStoreReadOperations,
    ),
  agentLifecycle: () =>
    import("./agent-lifecycle-read.worker.js").then((m) => m.agentLifecycleReadOperations),
  agentRecovery: () =>
    import("./agent-deletion-recovery.worker.js").then((m) => m.agentRecoveryReadOperations),
  legacySessionMigration: () =>
    import("../config/sessions/legacy-main-session-ledger.read.worker.js").then(
      (m) => m.legacySessionMigrationReadOperations,
    ),
  gatewayBoot: () =>
    import("../infra/gateway-boot-lifecycle.kernel.js").then((m) => m.gatewayBootReadOperations),
  localWorkspace: () =>
    import("../gateway/worker-environments/local-workspace-store.kernel.js").then(
      (m) => m.localWorkspaceReadOperations,
    ),
  config: () =>
    import("../config/io.health-state.kernel.js").then((m) => m.configHealthReadOperations),
  plugins: async () => {
    const [migrations, metadata] = await Promise.all([
      import("../infra/deferred-plugin-migrations.js").then(
        (m) => m.deferredPluginMigrationReadOperations,
      ),
      import("../plugins/plugin-metadata-state.read.worker.js").then(
        (m) => m.pluginMetadataReadOperations,
      ),
    ]);
    return {
      ...migrations,
      ...metadata,
    };
  },
  generatedHtmlProvenance: () =>
    import("../media/generated-html-provenance.worker.js").then(
      (m) => m.generatedHtmlProvenanceReadOperations,
    ),
  pairing: () => import("../pairing/pairing-store-sqlite.js").then((m) => m.pairingReadOperations),
  mentions: () => import("../gateway/mention-inbox.worker.js").then((m) => m.mentionReadOperations),
  skillLibrary: () =>
    import("../skills/library/read.kernel.js").then((m) => m.skillLibraryReadOperations),
  secrets: () =>
    import("../secrets/store/secret-store-metadata.kernel.js").then(
      (m) => m.secretStoreReadOperations,
    ),
  sessionState: () =>
    import("../sessions/session-state-events.read.worker.js").then(
      (m) => m.sessionStateReadOperations,
    ),
  // Session-state handlers also require this kernel in the same lazy read-worker graph.
  sessionUpstream: async () => sessionUpstreamReadOperations,
  diagnostic: () =>
    import("../infra/sqlite-audit-record.kernel.js").then((m) => m.diagnosticReadOperations),
  restartLifecycle: () =>
    import("../infra/restart-handoff.read.worker.js").then((m) => m.restartHandoffReadOperations),
  restartSentinel: () =>
    import("../infra/restart-sentinel.read.worker.js").then((m) => m.restartSentinelReadOperations),
};

type Operations = WorkerOperationsFromLoaders<typeof loaders>;
export type RegisteredStateReadCommand = SqliteWorkerCommand<Operations>;
export type RegisteredStateReadResult = Operations[keyof Operations]["output"];

export const stateReadRegistry = createWorkerOperationRegistry<Operations, EngineConnection>(
  loaders,
);
