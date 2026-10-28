import type { EngineConnection } from "../../infra/sql-connection.js";
import { readSqliteDatabaseScopedWriteToken } from "../../infra/sqlite-database-admission.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import { bindSqliteWorkerDatabase } from "../../infra/sqlite-worker-binding.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import type { SessionEntryLifecycleUpsert } from "./session-accessor.lifecycle-types.js";
import { hasPendingSessionTranscriptArchives } from "./session-accessor.sqlite-archive-store-kernel.js";
import { collectLifecycleIdentityChanges } from "./session-accessor.sqlite-identity.js";
import {
  finishProjectedLifecycleRemovalPlans,
  readProjectedLifecycleStore,
  selectProjectedLifecycleRemovals,
} from "./session-accessor.sqlite-lifecycle-state.js";
import type {
  LifecycleRemovalProjectionInput,
  ProjectedLifecycleMutation,
} from "./session-accessor.sqlite-lifecycle-types.js";
import { commitPreparedSessionEntryLifecycleMutationInDatabase } from "./session-accessor.sqlite-projection-state.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import { prepareSessionActorEntryPatch } from "./session-actor-entry-publication.worker.js";
import { transferSessionEntryWorkerCandidate } from "./session-entry-patch.worker.js";
import type { SessionEntryWritePostimages } from "./session-entry-write-postimage.js";
import type {
  SessionLifecycleProjectionCommit,
  SessionLifecycleProjectionCommitted,
} from "./session-lifecycle-projection.types.js";
import type { SessionEntry } from "./types.js";

export function commitSessionLifecycleProjection(
  input: SessionLifecycleProjectionCommit,
  { writeTransaction, admit, options }: AgentWorkerOperationContext,
) {
  return writeTransaction("session.lifecycle.project", "Session lifecycle", (database) => {
    const progressCardResetKeys: string[] = [];
    const projectionReconcileSessionIds: string[] = [];
    const postimages: SessionEntryWritePostimages = new Map();
    const archivedPrevious = new Map<string, SessionEntry>();
    const upsert = input.projected.upsertedEntries[0];
    // Compound lifecycle changes keep their ordinary cold-read fallback.
    const publishActorEntry =
      input.projected.upsertedEntries.length === 1 &&
      input.projected.removals.length === 0 &&
      upsert &&
      !upsert.resetBoundary
        ? prepareSessionActorEntryPatch(database, upsert.sessionKey)
        : undefined;
    const result = commitPreparedSessionEntryLifecycleMutationInDatabase(
      database,
      input,
      input.removalPlans,
      {
        resetScope: { agentId: input.agentId, path: database.path, env: options.env },
        currentEntrySnapshot: publishActorEntry?.snapshot(),
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
        { captureFullFacts: true, postimages },
      ),
    };
    if (
      result.maintenancePlans.every(
        (plan) => plan.archivedEntries.length === 0 && plan.entryRemovals.length === 0,
      )
    ) {
      publishActorEntry?.publish(postimages, candidate.publication);
    }
    const receipt = transferSessionEntryWorkerCandidate(database, admit, candidate);
    return receipt;
  });
}

type LifecycleProjectionPreparation = {
  store: Record<string, SessionEntry>;
  reuseEntry?: boolean;
  selected: ReturnType<typeof selectProjectedLifecycleRemovals>;
  archiveRecovery?: ProjectedLifecycleMutation["archiveRecovery"];
};

export type SessionLifecyclePlanningOperations = {
  prepare: {
    input: LifecycleRemovalProjectionInput & {
      upserts: readonly Pick<SessionEntryLifecycleUpsert, "sessionKey" | "relatedSessionKeys">[];
      retainedEntry?: {
        writeToken: string;
        writeScopes: Parameters<typeof readSqliteDatabaseScopedWriteToken>[1];
      };
    };
    output: LifecycleProjectionPreparation;
  };
  finish: {
    input: Pick<LifecycleProjectionPreparation, "store" | "selected"> & {
      archiveDirectory: string;
    };
    output: ReturnType<typeof finishProjectedLifecycleRemovalPlans>;
  };
};

/** Private planning commands borrow the executor's admitted connection. */
export function bindSqliteWorkerBackend(
  binding: { agentId: string },
  context: { database: EngineConnection; databasePath: string },
): SqliteWorkerBackend<SessionLifecyclePlanningOperations> {
  const database = getOpenClawAgentDatabaseIfOpen({
    agentId: binding.agentId,
    path: context.databasePath,
    env: getSqliteWorkerStateContext().environment,
  });
  if (!database || database.db !== context.database || database.path !== context.databasePath) {
    throw new Error("Session lifecycle planning lost its canonical database owner");
  }
  return bindSqliteWorkerDatabase<SessionLifecyclePlanningOperations>(database.db, {
    execute(command) {
      const prepare = () => {
        if (command.type === "prepare") {
          const input = command.input;
          const upsert = input.upserts[0];
          const reuseEntry =
            input.retainedEntry !== undefined &&
            input.retainedEntry.writeToken ===
              readSqliteDatabaseScopedWriteToken(database.db, input.retainedEntry.writeScopes);
          const retained =
            !reuseEntry &&
            !input.allowCanonicalRepair &&
            input.removals.length === 0 &&
            input.upserts.length === 1 &&
            upsert &&
            !upsert.relatedSessionKeys?.some((key) => key !== upsert.sessionKey.trim())
              ? prepareSessionActorEntryPatch(database, upsert.sessionKey.trim())?.snapshot()
              : undefined;
          // Related-parent builders still require their complete multi-entry projection.
          const store = reuseEntry
            ? {}
            : retained &&
                (upsert?.relatedSessionKeys === undefined || !retained.entry.parentSessionKey)
              ? { [retained.sessionKey]: retained.entry }
              : readProjectedLifecycleStore(database, input);
          const identity = readOpenClawAgentDatabaseIdentity(database).identity;
          return {
            store,
            ...(reuseEntry ? { reuseEntry: true } : {}),
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
        );
      };
      // Without removals, bounded row reads share this worker without yielding.
      // Archive recovery is an independent hint carried across asynchronous builders.
      return command.type === "prepare" && command.input.removals.length === 0
        ? prepare()
        : runSqliteReadSnapshotSync(database.db, prepare);
    },
  });
}
