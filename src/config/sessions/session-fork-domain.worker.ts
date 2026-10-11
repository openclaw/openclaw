import type { DatabaseSync } from "node:sqlite";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseAdmissionRestriction } from "../../state/openclaw-agent-execution-domain.js";
import { createSessionWorkerOperationContext } from "./session-entry-patch.worker.js";
import { commitSessionForkMessageCut } from "./session-message-cut.worker.js";
import type { SessionForkOperations } from "./session-parent-fork.types.js";
import {
  commitParentFork,
  prepareParentForkEntry,
  readParentForkSource,
} from "./session-parent-fork.worker.js";

/** The domain lends the canonical executor's connection and admission, never a second writer. */
export function bindSqliteWorkerBackend(
  input: { agentId: string },
  bound: {
    database: DatabaseSync;
    databasePath: string;
    admit(stage: "transaction" | "commit", restriction?: AgentDatabaseAdmissionRestriction): void;
  },
): SqliteWorkerBackend<SessionForkOperations> {
  const options = {
    agentId: input.agentId,
    path: bound.databasePath,
    env: getSqliteWorkerStateContext().environment,
  };
  const database = getOpenClawAgentDatabaseIfOpen(options);
  if (!database || database.db !== bound.database || database.path !== bound.databasePath) {
    throw new Error("Session fork lost its canonical database owner");
  }
  const context = createSessionWorkerOperationContext(database, options, bound, "Session fork");
  return {
    execute(command) {
      switch (command.type) {
        case "session.parentFork.prepare":
          return prepareParentForkEntry(command.input, context);
        case "session.parentFork.source":
          return readParentForkSource(command.input, context);
        case "session.parentFork.commit":
          return commitParentFork(command.input, context);
        case "session.messageCut.fork":
          return commitSessionForkMessageCut(command.input, context);
      }
      throw new Error("Unknown session fork domain operation");
    },
    assertSettled() {
      assertTransactionUsable(bound.database);
      if (bound.database.isTransaction) {
        throw new Error("Session fork transaction did not settle");
      }
    },
    close() {},
  };
}
