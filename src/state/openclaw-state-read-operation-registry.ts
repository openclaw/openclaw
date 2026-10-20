import type { EngineConnection } from "../infra/sql-connection.js";
import { diagnosticReadOperations } from "../infra/sqlite-audit-record.kernel.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { pluginMetadataReadOperations } from "../plugins/plugin-metadata-state.read.worker.js";
import { sessionUpstreamReadOperations } from "../sessions/session-upstream-links.kernel.js";
import {
  createWorkerOperationRegistry,
  type WorkerOperationsFromLoaders,
} from "./worker-operation-registry.js";

const loaders = {
  sandboxPersistentExec: () =>
    import("../agents/sandbox/persistent-exec-store.kernel.js").then(
      (m) => m.sandboxPersistentExecReadOperations,
    ),
  worktrees: async () => {
    const [
      { worktreeReadOperations },
      { worktreeTemplateReadOperations },
      { pendingWorktreeReadOperations },
    ] = await Promise.all([
      import("../agents/worktrees/registry-read.kernel.js"),
      import("../agents/worktrees/template-registry.worker.js"),
      import("../agents/worktrees/pending-slots.worker.js"),
    ]);
    return {
      ...worktreeReadOperations,
      ...worktreeTemplateReadOperations,
      ...pendingWorktreeReadOperations,
    };
  },
  agentProvenance: () =>
    import("./agent-provenance.kernel.js").then((m) => m.agentProvenanceReadOperations),
  managedImages: () =>
    import("../gateway/managed-image-record-store.kernel.js").then(
      (m) => m.managedImageRecordReadOperations,
    ),
  githubPublications: () =>
    import("./github-publication.read.worker.js").then((m) => m.publicationReadOperations),
  userGitHubConnections: () =>
    import("./user-github-connections.worker.js").then((m) => m.userGitHubConnectionReadOperations),
  stateBootstrap: () =>
    import("./state-bootstrap-read.worker.js").then((m) => m.stateBootstrapReadOperations),
  machineState: () =>
    import("./config-machine-state.read.worker.js").then((m) => m.machineStateReadOperations),
  projects: () =>
    import("../projects/project-registry.kernel.js").then((m) => m.projectRegistryReadOperations),
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
    const { deferredPluginMigrationReadOperations } =
      await import("../infra/deferred-plugin-migrations.js");
    return {
      ...deferredPluginMigrationReadOperations,
      ...pluginMetadataReadOperations,
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
  // Session-state handlers also require this kernel in the read-worker graph.
  sessionUpstream: async () => sessionUpstreamReadOperations,
  // Schema readers already require this kernel in the read-worker graph.
  diagnostic: async () => diagnosticReadOperations,
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
