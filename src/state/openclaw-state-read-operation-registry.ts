import type { DatabaseSync } from "node:sqlite";
import type { configHealthReadOperations } from "../config/io.health-state.kernel.js";
import type { MentionReadOperations } from "../gateway/mention-inbox.worker-contract.js";
import type { localWorkspaceReadOperations } from "../gateway/worker-environments/local-workspace-store.kernel.js";
import type { DeferredPluginMigrationReadOperations } from "../infra/deferred-plugin-migrations.contract.js";
import type { RestartSentinelReadOperations } from "../infra/restart-sentinel.read.worker-contract.js";
import type { DiagnosticReadOperations } from "../infra/sqlite-audit-record.read-contract.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import type { GeneratedHtmlProvenanceReadOperations } from "../media/generated-html-provenance.worker-contract.js";
import type { PairingReadOperations } from "../pairing/pairing-store.types.js";
import type { SecretStoreReadOperations } from "../secrets/store/secret-store.types.js";
import type { SessionStateReadOperations } from "../sessions/session-state-events.read.worker-contract.js";
import type { SkillLibraryReadOperations } from "../skills/library/read.contract.js";
import {
  createWorkerOperationRegistry,
  type WorkerOperations,
} from "./worker-operation-registry.js";

type Operations = WorkerOperations<typeof localWorkspaceReadOperations> &
  DiagnosticReadOperations &
  GeneratedHtmlProvenanceReadOperations &
  PairingReadOperations &
  MentionReadOperations &
  SkillLibraryReadOperations &
  RestartSentinelReadOperations &
  SessionStateReadOperations &
  SecretStoreReadOperations &
  WorkerOperations<typeof configHealthReadOperations> &
  DeferredPluginMigrationReadOperations;
export type RegisteredStateReadCommand = SqliteWorkerCommand<Operations>;
export type RegisteredStateReadResult = Operations[keyof Operations]["output"];

export const stateReadRegistry = createWorkerOperationRegistry<Operations, DatabaseSync>({
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
  diagnostic: () =>
    import("../infra/sqlite-audit-record.kernel.js").then((m) => m.diagnosticReadOperations),
  restartSentinel: () =>
    import("../infra/restart-sentinel.read.worker.js").then((m) => m.restartSentinelReadOperations),
});
