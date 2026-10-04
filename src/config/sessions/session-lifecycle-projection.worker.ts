import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { assertSessionSubagentRunsCurrent } from "./session-accessor.sqlite-descendant-basis.js";
import { collectLifecycleIdentityChanges } from "./session-accessor.sqlite-identity.js";
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
