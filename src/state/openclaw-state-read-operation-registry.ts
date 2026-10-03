import type { DatabaseSync } from "node:sqlite";
import type { MentionReadOperations } from "../gateway/mention-inbox.worker-contract.js";
import type { RestartSentinelReadOperations } from "../infra/restart-sentinel.read.worker-contract.js";
import type { DiagnosticReadOperations } from "../infra/sqlite-audit-record.read-contract.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import type { SecretStoreReadOperations } from "../secrets/store/secret-store.types.js";
import type { SessionStateReadOperations } from "../sessions/session-state-events.read.worker-contract.js";
import { createWorkerOperationRegistry } from "./worker-operation-registry.js";

type Operations = DiagnosticReadOperations &
  MentionReadOperations &
  RestartSentinelReadOperations &
  SessionStateReadOperations &
  SecretStoreReadOperations;
export type RegisteredStateReadCommand = SqliteWorkerCommand<Operations>;
export type RegisteredStateReadResult = Operations[keyof Operations]["output"];

export const stateReadRegistry = createWorkerOperationRegistry<Operations, DatabaseSync>({
  mentions: () => import("../gateway/mention-inbox.worker.js").then((m) => m.mentionReadOperations),
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
