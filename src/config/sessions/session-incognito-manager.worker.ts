import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import {
  runWithSqliteWorkerStateContext,
  type SqliteWorkerStateContext,
} from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { AgentDatabaseAdmissionRestriction } from "../../state/openclaw-agent-execution-domain.js";
import type { IncognitoManagerOperations } from "./session-incognito-manager-contract.js";

/** Reuse SessionManager's connection-bound backend on the actor's sole native connection. */
export function createIncognitoManagerWorker(
  database: OpenClawAgentDatabase,
  environment: SqliteWorkerStateContext["environment"],
  admit: (
    stage: "transaction" | "commit",
    keys: readonly string[],
    restriction?: AgentDatabaseAdmissionRestriction,
  ) => void,
) {
  let backend:
    | ReturnType<
        typeof import("../../agents/sessions/session-manager-metadata.worker.js").bindSqliteWorkerBackend
      >
    | undefined;
  let sessionKey: string | undefined;
  return {
    async prepare() {
      const module: typeof import("../../agents/sessions/session-manager-metadata.worker.js") =
        await import(
          resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionManagerMetadata).href
        );
      backend = module.bindSqliteWorkerBackend(undefined, {
        databasePath: database.path,
        database: database.db,
        admit(stage, restriction) {
          if (!sessionKey) {
            throw new Error("Incognito SessionManager lost its command target");
          }
          admit(stage, [sessionKey], restriction);
        },
      });
    },
    execute(command: SqliteWorkerCommand<IncognitoManagerOperations>) {
      const { scope } = command.input.command.input;
      if (
        !backend ||
        scope.agentId !== database.agentId ||
        scope.storePath !== database.path ||
        scope.sessionKey !== command.input.sessionKey
      ) {
        throw new Error("Incognito SessionManager command changed its actor target");
      }
      sessionKey = scope.sessionKey;
      const current = backend;
      try {
        return {
          value: runWithSqliteWorkerStateContext({ environment }, () =>
            current.execute(command.input.command),
          ),
          keys: [sessionKey],
        };
      } finally {
        backend.assertSettled?.();
        backend.close();
        backend = undefined;
        sessionKey = undefined;
      }
    },
    assertSettled() {
      if (backend) {
        backend.assertSettled?.();
        backend.close();
        backend = undefined;
      }
    },
    close() {
      backend?.close();
      backend = undefined;
    },
  };
}
