import type { DatabaseSync } from "node:sqlite";
import {
  assertTransactionUsable,
  runSqliteDeferredTransactionSync,
} from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { hasPendingSessionTranscriptArchives } from "./session-accessor.sqlite-archive-store-kernel.js";
import { assertSessionSubagentRunsCurrent } from "./session-accessor.sqlite-descendant-basis.js";
import {
  readSessionEntryCount,
  readSessionEntryStore,
} from "./session-accessor.sqlite-entry-store.js";
import { collectLifecycleIdentityChanges } from "./session-accessor.sqlite-identity.js";
import {
  finishProjectedLifecycleRemovalPlans,
  selectProjectedLifecycleRemovals,
} from "./session-accessor.sqlite-lifecycle-state.js";
import type {
  LifecycleRemovalProjectionInput,
  ProjectedLifecycleMutation,
} from "./session-accessor.sqlite-lifecycle-types.js";
import { commitPreparedSessionEntryLifecycleMutationInDatabase } from "./session-accessor.sqlite-projection-state.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import { transferSessionEntryWorkerCandidate } from "./session-entry-patch.worker.js";
import type {
  SessionLifecycleProjectionCommit,
  SessionLifecycleProjectionCommitted,
} from "./session-lifecycle-projection.types.js";

export function commitSessionLifecycleProjection(
  input: SessionLifecycleProjectionCommit,
  { writeTransaction, admit, options }: AgentWorkerOperationContext,
) {
  return writeTransaction("session.lifecycle.project", "Session lifecycle", (database) => {
    assertSessionSubagentRunsCurrent(input, options.env ?? process.env);
    const progressCardResetKeys: string[] = [];
    const projectionReconcileSessionIds: string[] = [];
    const result = commitPreparedSessionEntryLifecycleMutationInDatabase(
      database,
      input,
      input.removalPlans,
      {
        resetScope: { agentId: input.agentId, path: database.path, env: options.env },
        onResetBoundary: ({
          sessionKey,
          sessionId,
          progressCardReset,
          projectionNeedsReconcile,
        }) => {
          if (progressCardReset) {
            progressCardResetKeys.push(sessionKey);
          }
          if (projectionNeedsReconcile) {
            projectionReconcileSessionIds.push(sessionId);
          }
        },
      },
    );
    const candidate: SessionLifecycleProjectionCommitted = {
      kind: "session-lifecycle-projection",
      result,
      progressCardResetKeys,
      projectionReconcileSessionIds,
      publication: prepareSessionEntryReplacementPublication(
        {
          ...collectLifecycleIdentityChanges(input.projected, result.removedSessionKeys),
          pendingArchiveRecovery: result.pendingArchives,
          membershipInvalidatedKeys: [
            ...result.removedSessionKeys,
            ...input.projected.upsertedEntries.flatMap(({ sessionKey, entry, expectedEntry }) =>
              entry.sessionId !== expectedEntry?.sessionId ? [sessionKey] : [],
            ),
          ],
          maintenancePlans: result.maintenancePlans,
        },
        database,
      ),
    };
    const receipt = transferSessionEntryWorkerCandidate(database, admit, candidate);
    assertSessionSubagentRunsCurrent(input, options.env ?? process.env);
    return receipt;
  });
}

type LifecycleProjectionPreparation = {
  store: ReturnType<typeof readSessionEntryStore>;
  selected: ReturnType<typeof selectProjectedLifecycleRemovals>;
  archiveRecovery?: ProjectedLifecycleMutation["archiveRecovery"];
};

export type SessionLifecyclePlanningOperations = {
  count: { input: undefined; output: number };
  prepare: {
    input: LifecycleRemovalProjectionInput & { upsertSessionKeys: string[] };
    output: LifecycleProjectionPreparation;
  };
  finish: {
    input: LifecycleProjectionPreparation & {
      archiveDirectory: string;
      upsertedEntries: ProjectedLifecycleMutation["upsertedEntries"];
    };
    output: ProjectedLifecycleMutation;
  };
};

/** Private planning commands borrow the executor's admitted connection. */
export function bindSqliteWorkerBackend(
  binding: { agentId: string },
  context: { database: DatabaseSync; databasePath: string },
): SqliteWorkerBackend<SessionLifecyclePlanningOperations> {
  const database = getOpenClawAgentDatabaseIfOpen({
    agentId: binding.agentId,
    path: context.databasePath,
    env: getSqliteWorkerStateContext().environment,
  });
  if (!database || database.db !== context.database || database.path !== context.databasePath) {
    throw new Error("Session lifecycle planning lost its canonical database owner");
  }
  let closed = false;
  const assertOpen = () => {
    if (closed || !database.db.isOpen) {
      throw new Error("Session lifecycle planning domain is closed");
    }
    assertTransactionUsable(database.db);
  };
  return {
    execute(command) {
      assertOpen();
      if (command.type === "count") {
        return readSessionEntryCount(database);
      }
      return runSqliteDeferredTransactionSync(database.db, () => {
        if (command.type === "prepare") {
          const input = command.input;
          const store = readSessionEntryStore(database, {
            sessionKeys: [
              ...input.removals.map((removal) =>
                removal.exactStoredKey ? removal.sessionKey : removal.sessionKey.trim(),
              ),
              ...input.upsertSessionKeys,
            ],
          });
          const identity = readOpenClawAgentDatabaseIdentity(database).identity;
          return {
            store,
            selected: selectProjectedLifecycleRemovals(database, store, input.removals),
            archiveRecovery:
              typeof identity === "string"
                ? {
                    pending: hasPendingSessionTranscriptArchives(database),
                    databaseIdentity: identity,
                  }
                : undefined,
          };
        }
        const input = command.input;
        return finishProjectedLifecycleRemovalPlans(
          database,
          input.archiveDirectory,
          input.store,
          input.selected,
          input.upsertedEntries,
        );
      });
    },
    assertSettled() {
      assertOpen();
      if (database.db.isTransaction) {
        throw new Error("Session lifecycle planning left a transaction open");
      }
    },
    close() {
      closed = true;
    },
  };
}
