import type { DatabaseSync } from "node:sqlite";
import type { AgentDeletionSessionStoreReadOperations } from "../agents/agent-delete-session-store-safety.worker-contract.js";
import type { ClawMonitorCleanupReadOperations } from "../claws/monitor-cleanup.read.types.js";
import type { configHealthReadOperations } from "../config/io.health-state.kernel.js";
import type { legacySessionMigrationReadOperations } from "../config/sessions/legacy-main-session-ledger.read.worker.js";
import type { ProactiveJobReceiptReadOperations } from "../cron/proactive-job-receipt.types.js";
import type { MentionReadOperations } from "../gateway/mention-inbox.worker-contract.js";
import type { localWorkspaceReadOperations } from "../gateway/worker-environments/local-workspace-store.kernel.js";
import type { DeferredPluginMigrationReadOperations } from "../infra/deferred-plugin-migrations.contract.js";
import type { gatewayBootReadOperations } from "../infra/gateway-boot-lifecycle.kernel.js";
import type { RestartSentinelReadOperations } from "../infra/restart-sentinel.read.worker-contract.js";
import type { DiagnosticReadOperations } from "../infra/sqlite-audit-record.read-contract.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import type { GeneratedHtmlProvenanceReadOperations } from "../media/generated-html-provenance.worker-contract.js";
import type { PairingReadOperations } from "../pairing/pairing-store.types.js";
import type { SecretStoreReadOperations } from "../secrets/store/secret-store.types.js";
import type { SessionStateReadOperations } from "../sessions/session-state-events.read.worker-contract.js";
import type { sessionUpstreamReadOperations } from "../sessions/session-upstream-links.kernel.js";
import type { SkillLibraryReadOperations } from "../skills/library/read.contract.js";
import type { AgentRecoveryReadOperations } from "./agent-deletion-recovery.read-contract.js";
import type { agentLifecycleReadOperations } from "./agent-lifecycle-read.kernel.js";
import {
  createWorkerOperationRegistry,
  type WorkerOperations,
} from "./worker-operation-registry.js";

type Operations = WorkerOperations<typeof localWorkspaceReadOperations> &
  AgentDeletionSessionStoreReadOperations &
  WorkerOperations<typeof legacySessionMigrationReadOperations> &
  AgentRecoveryReadOperations &
  WorkerOperations<typeof agentLifecycleReadOperations> &
  WorkerOperations<typeof gatewayBootReadOperations> &
  DiagnosticReadOperations &
  GeneratedHtmlProvenanceReadOperations &
  PairingReadOperations &
  MentionReadOperations &
  SkillLibraryReadOperations &
  ClawMonitorCleanupReadOperations &
  RestartSentinelReadOperations &
  SessionStateReadOperations &
  WorkerOperations<typeof sessionUpstreamReadOperations> &
  SecretStoreReadOperations &
  ProactiveJobReceiptReadOperations &
  WorkerOperations<typeof configHealthReadOperations> &
  DeferredPluginMigrationReadOperations;
export type RegisteredStateReadCommand = SqliteWorkerCommand<Operations>;
export type RegisteredStateReadResult = Operations[keyof Operations]["output"];

export const stateReadRegistry = createWorkerOperationRegistry<Operations, DatabaseSync>({
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
  clawMonitorCleanup: () =>
    import("../claws/monitor-cleanup.read.worker.js").then(
      (m) => m.clawMonitorCleanupReadOperations,
    ),
  automationProactive: () =>
    import("../cron/proactive-job-receipt.read.worker.js").then(
      (m) => m.proactiveJobReceiptReadOperations,
    ),
  diagnostic: () =>
    import("../infra/sqlite-audit-record.kernel.js").then((m) => m.diagnosticReadOperations),
  restartSentinel: () =>
    import("../infra/restart-sentinel.read.worker.js").then((m) => m.restartSentinelReadOperations),
});
