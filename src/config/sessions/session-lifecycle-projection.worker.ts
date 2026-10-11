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
import type { SessionEntryWritePostimages } from "./session-entry-write-postimage.js";
import type {
  SessionLifecycleProjectionCommit,
  SessionLifecycleProjectionCommitted,
} from "./session-lifecycle-projection.types.js";
import { MaintenancePreservationRequiredError } from "./session-mutation-conflict-error.js";
import type { SessionEntry } from "./types.js";

export function commitSessionLifecycleProjection(
  input: SessionLifecycleProjectionCommit,
  { writeTransaction, admit, options, open }: AgentWorkerOperationContext,
) {
  try {
    return writeTransaction("session.lifecycle.project", "Session lifecycle", (database) => {
      assertSessionSubagentRunsCurrent(input, options.env ?? process.env);
      const progressCardResetKeys: string[] = [];
      const projectionReconcileSessionIds: string[] = [];
      const postimages: SessionEntryWritePostimages = new Map();
      const archivedPrevious = new Map<string, SessionEntry>();
      const result = commitPreparedSessionEntryLifecycleMutationInDatabase(
        database,
        input,
        input.removalPlans,
        {
          resetScope: { agentId: input.agentId, path: database.path, env: options.env },
          postimages,
          onArchived: (sessionKey, previous) => archivedPrevious.set(sessionKey, previous),
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
      const identity = collectLifecycleIdentityChanges(input.projected, result.removedSessionKeys);
      for (const [sessionKey, previous] of archivedPrevious) {
        if (!identity.previous.has(sessionKey)) {
          identity.previous.set(sessionKey, previous);
        }
      }
      for (const sessionKey of identity.current.keys()) {
        if (!postimages.has(sessionKey)) {
          identity.current.delete(sessionKey);
        }
      }
      for (const [sessionKey, postimage] of postimages) {
        identity.current.set(sessionKey, postimage.entry);
      }
      const candidate: SessionLifecycleProjectionCommitted = {
        kind: "session-lifecycle-projection",
        result,
        progressCardResetKeys,
        projectionReconcileSessionIds,
        publication: prepareSessionEntryReplacementPublication(
          {
            ...identity,
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
          { postimages },
        ),
      };
      const receipt = transferSessionEntryWorkerCandidate(database, admit, candidate);
      assertSessionSubagentRunsCurrent(input, options.env ?? process.env);
      return receipt;
    });
  } catch (error) {
    if (!(error instanceof MaintenancePreservationRequiredError)) {
      throw error;
    }
    const database = open();
    assertTransactionUsable(database.db);
    if (database.db.isTransaction) {
      throw error;
    }
    return { kind: "maintenance-preservation-required" } as const;
  }
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
      const prepare = () => {
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
      };
      // Without removals the inventory is one statement. Archive recovery is an
      // independent scheduling hint, already carried across asynchronous builders.
      return command.type === "prepare" && command.input.removals.length === 0
        ? prepare()
        : runSqliteDeferredTransactionSync(database.db, prepare);
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
