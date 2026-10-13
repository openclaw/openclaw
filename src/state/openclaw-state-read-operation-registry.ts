import type { DatabaseSync } from "node:sqlite";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import {
  createWorkerOperationRegistry,
  type WorkerOperationsFromLoaders,
} from "./worker-operation-registry.js";

const loaders = {
  agentDeletion: () =>
    import("../agents/agent-delete-session-store-safety.kernel.js").then(
      (m) => m.agentDeletionSessionStoreReadOperations,
    ),
  agentLifecycle: () =>
    import("./agent-lifecycle-read.kernel.js").then((m) => m.agentLifecycleReadOperations),
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
  plugins: () =>
    import("../infra/deferred-plugin-migrations.js").then(
      (m) => m.deferredPluginMigrationReadOperations,
    ),
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
  sessionUpstream: () =>
    import("../sessions/session-upstream-links.kernel.js").then(
      (m) => m.sessionUpstreamReadOperations,
    ),
  diagnostic: () =>
    import("../infra/sqlite-audit-record.kernel.js").then((m) => m.diagnosticReadOperations),
  restartSentinel: () =>
    import("../infra/restart-sentinel.read.worker.js").then((m) => m.restartSentinelReadOperations),
};

type Operations = WorkerOperationsFromLoaders<typeof loaders>;
export type RegisteredStateReadCommand = SqliteWorkerCommand<Operations>;
export type RegisteredStateReadResult = Operations[keyof Operations]["output"];

export const stateReadRegistry = createWorkerOperationRegistry<Operations, DatabaseSync>(loaders);
