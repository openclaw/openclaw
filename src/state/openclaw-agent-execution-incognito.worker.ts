import { isMainThread } from "node:worker_threads";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-lifecycle-errors.js";
import type {
  SqliteWorkerEphemeralTarget,
  SqliteWorkerPreparedBackend,
} from "../infra/sqlite-worker-contract.js";
import {
  requestSqliteWorkerOperationAdmission,
  SqliteWorkerOpenRefusedError,
} from "../infra/sqlite-worker-operation-admission.js";
import {
  closeOpenClawAgentDatabaseByPath,
  retainAgentDatabase,
} from "./openclaw-agent-db-lifecycle.js";
import { getOpenClawAgentDatabaseIfOpen, openOpenClawAgentDatabase } from "./openclaw-agent-db.js";
import { isIncognitoOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import type {
  AgentDatabaseIncognitoOpen,
  AgentDatabaseIncognitoOperations,
} from "./openclaw-agent-execution-contract.js";

/** The ephemeral arm of the canonical agent executor; no file/domain operation is admitted yet. */
export function createIncognitoAgentDatabaseBackend(
  input: AgentDatabaseIncognitoOpen,
  opening: { databasePath: string; target?: SqliteWorkerEphemeralTarget },
): SqliteWorkerPreparedBackend<AgentDatabaseIncognitoOperations> {
  const options = { agentId: input.agentId, path: input.databasePath, env: input.environment };
  if (
    isMainThread ||
    opening.databasePath !== input.databasePath ||
    opening.target?.kind !== "ephemeral" ||
    opening.target.handle !== input.identity.handle ||
    opening.target.incarnation !== input.identity.incarnation ||
    !isIncognitoOpenClawAgentSqlitePath(input.databasePath, options)
  ) {
    throw new Error("Incognito open differs from its worker-owned target");
  }
  try {
    requestSqliteWorkerOperationAdmission({ stage: "open", facts: input });
  } catch (error) {
    throw new SqliteWorkerOpenRefusedError(error);
  }
  if (getOpenClawAgentDatabaseIfOpen(options)) {
    throw new Error("Incognito actor cannot adopt another native database");
  }
  const database = openOpenClawAgentDatabase(options);
  const release = retainAgentDatabase(database.db);
  let closed = false;
  const close = () => {
    // Native cleanup failure keeps this exact actor unavailable and under broker custody.
    closed = true;
    closeOpenClawAgentDatabaseByPath(database.path, database.agentId);
    release();
  };
  try {
    if (database.db.location()) {
      throw new Error("Incognito actor requires memory-only SQLite storage");
    }
    requestSqliteWorkerOperationAdmission({
      stage: "prepare",
      facts: { identity: input.identity },
    });
  } catch (error) {
    try {
      close();
    } catch (cleanupError) {
      throw createSqliteLifecycleAggregateError(
        [error, cleanupError],
        "Incognito open and cleanup failed",
        error,
      );
    }
    throw error;
  }
  const assertCurrent = () => {
    if (closed || !database.db.isOpen || getOpenClawAgentDatabaseIfOpen(options) !== database) {
      throw new Error("Incognito actor lost its retained native database");
    }
  };
  return {
    execute(command) {
      assertCurrent();
      requestSqliteWorkerOperationAdmission({
        stage: "prepare",
        facts: { identity: input.identity },
      });
      if (command.type !== "database.incognito.memory") {
        throw new Error("Operation is not admitted for incognito storage");
      }
      // sqlite-allow-raw -- Connection diagnostics have no Kysely table representation.
      const pageCount = database.db.prepare("PRAGMA page_count").get()?.page_count;
      // sqlite-allow-raw -- SQLite supplies the native allocation unit for this gauge.
      const pageSize = database.db.prepare("PRAGMA page_size").get()?.page_size;
      if (typeof pageCount !== "number" || typeof pageSize !== "number") {
        throw new Error("Incognito memory diagnostics are unavailable");
      }
      return { agentId: input.agentId, pageCount, pageSize, databaseBytes: pageCount * pageSize };
    },
    assertSettled() {
      assertCurrent();
      if (database.db.isTransaction) {
        throw new Error("Incognito command left an unsettled native transaction");
      }
    },
    close,
  };
}
