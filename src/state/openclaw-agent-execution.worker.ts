import {
  claimHeartbeatOutcomeRowInDatabase,
  persistHeartbeatOutcomeInDatabase,
} from "../infra/heartbeat-outcome-store.kernel.js";
import type { SqliteWorkerBackend } from "../infra/sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { readOpenClawAgentDatabaseIdentity } from "./openclaw-agent-db-identity.js";
import { prepareOpenClawAgentDatabaseWorkerLease } from "./openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabaseByPath,
  retainAgentDatabase,
} from "./openclaw-agent-db-lifecycle.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "./openclaw-agent-db.js";
import type {
  AgentDatabaseExecutionIdentity,
  AgentDatabaseExecutionOpen,
  AgentDatabaseOperations,
} from "./openclaw-agent-execution-contract.js";
import {
  requireStateDatabaseIdentity,
  retainOpenClawStateDatabase,
} from "./openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";

const log = createSubsystemLogger("state/agent-db");

/** The broker supplies a private admission channel before invoking this native factory. */
export function createSqliteWorkerBackend(
  input: AgentDatabaseExecutionOpen,
  opening: { databasePath: string },
): SqliteWorkerBackend<AgentDatabaseOperations> {
  if (opening.databasePath !== input.databasePath) {
    throw new Error("Agent database open does not match its captured execution owner");
  }
  requestSqliteWorkerOperationAdmission({ stage: "open", facts: input });
  const options = { agentId: input.agentId, path: input.databasePath, env: input.environment };
  const shared = openOpenClawStateDatabase({
    path: input.stateDatabasePath,
    env: input.environment,
  });
  const sharedBorrow = retainOpenClawStateDatabase(shared);
  const lease = prepareOpenClawAgentDatabaseWorkerLease(options, shared, input.leaseId);
  requestSqliteWorkerOperationAdmission({
    stage: "prepare",
    facts: {
      kind: "shared-owner",
      identity: requireStateDatabaseIdentity(shared),
      lease: lease.receipt,
    },
  });
  // A throwing factory retains its dependencies until the broker joins native VM exit.
  const database = openOpenClawAgentDatabase(options, lease);
  const releaseBorrow = retainAgentDatabase(database.db);
  const nativeIdentity = readOpenClawAgentDatabaseIdentity(database);
  if (typeof nativeIdentity.identity !== "string") {
    throw new Error("Disk agent execution requires its canonical file identity");
  }
  const identity: AgentDatabaseExecutionIdentity = {
    kind: "file",
    physicalIdentity: nativeIdentity.identity,
    incarnation: nativeIdentity.incarnation,
    nativeLocation: nativeIdentity.filename,
  };
  let closed = false;
  const assertOpen = () => {
    if (closed || !database.db.isOpen) {
      throw new Error("Agent database execution owner is closed");
    }
  };
  return {
    execute(command) {
      assertOpen();
      requestSqliteWorkerOperationAdmission({ stage: "prepare", facts: { identity } });
      if (command.type === "database.identity") {
        return identity;
      }
      const write = <T>(operation: () => T): T => {
        let result: { value: T } | undefined;
        let committed = false;
        try {
          return runOpenClawAgentWriteTransaction(
            (current) => {
              if (current !== database || !database.db.isTransaction) {
                throw new Error("Agent operation requires its canonical native transaction");
              }
              requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: { identity } });
              const value = operation();
              result = { value };
              return value;
            },
            options,
            {
              operationLabel:
                command.type === "heartbeat.persist"
                  ? "heartbeat.outcome.persist"
                  : "heartbeat.outcome.claim",
              onCommitted: () => {
                committed = true;
              },
            },
          );
        } catch (error) {
          if (!committed || !result) {
            throw error;
          }
          try {
            log.warn("Agent database operation committed before cleanup failed", {
              operation: command.type,
              error,
            });
          } catch {
            // A diagnostic failure cannot make a known commit replayable.
          }
          return result.value;
        }
      };
      return command.type === "heartbeat.persist"
        ? write(() => persistHeartbeatOutcomeInDatabase(database.db, command.input))
        : write(() => claimHeartbeatOutcomeRowInDatabase(database.db, command.input));
    },
    close() {
      closed = true;
      closeOpenClawAgentDatabaseByPath(database.path, database.agentId);
      releaseBorrow();
      sharedBorrow.release();
    },
  };
}
