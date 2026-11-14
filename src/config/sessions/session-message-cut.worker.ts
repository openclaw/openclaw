import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { withSqliteSessionDeletionWorkerParticipant } from "./session-accessor.sqlite-deletion.js";
import { readSessionIdentitySnapshot } from "./session-accessor.sqlite-entry-store.js";
import { mutateSqliteSessionAtMessageInTransaction } from "./session-accessor.sqlite-message-cut.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-publication.js";
import { transferSessionEntryWorkerCandidate } from "./session-entry-patch.worker.js";
import { refuseInPlaceSessionMessageCutInDatabase } from "./session-message-cut-in-place.kernel.js";
import type {
  SessionMessageCutCandidate,
  SessionMessageCutCommit,
  SessionMessageCutIntent,
  SessionMessageCutPreflight,
} from "./session-message-cut.types.js";
import { runSessionNativeBindingTransaction } from "./session-native-binding.worker.js";
import type { SessionForkMessageCutCommit } from "./session-parent-fork.types.js";
import { collectSessionEntryLookupKeys } from "./store-entry.js";

/**
 * Indexed precheck for an in-place cut, before its local workspace is retired.
 *
 * The commit transaction revalidates the same preconditions through the same
 * reader, so this read only avoids retiring custody for a cut that must refuse.
 */
export function preflightSessionMessageCut(
  input: SessionMessageCutPreflight,
  context: AgentWorkerOperationContext,
) {
  return refuseInPlaceSessionMessageCutInDatabase(
    context.open(),
    input.sessionId,
    input.entry,
    input.intent,
    input.sourceRepositoryWorkspaceId,
  );
}

export function commitSessionForkMessageCut(
  input: SessionForkMessageCutCommit,
  context: AgentWorkerOperationContext,
) {
  return commitSessionMessageCut(
    { agentId: input.agentId, intent: input.intent },
    context,
    input.sourceRepositoryWorkspaceId,
  );
}

export function commitSessionMessageCut(
  input: Omit<SessionMessageCutCommit, "intent"> & { intent: SessionMessageCutIntent },
  context: AgentWorkerOperationContext,
  sourceRepositoryWorkspaceId?: string,
) {
  const mutate = (database: OpenClawAgentDatabase) => {
    const intent = input.intent;
    const identityKeys = uniqueStrings([
      ...collectSessionEntryLookupKeys(intent.sourceKey),
      ...collectSessionEntryLookupKeys(intent.targetKey),
    ]);
    const previous = readSessionIdentitySnapshot(database, identityKeys);
    let projectionNeedsReconcile = false;
    const result = mutateSqliteSessionAtMessageInTransaction(
      database,
      { ...context.options, agentId: input.agentId, sessionKey: intent.sourceKey },
      intent,
      {
        sourceRepositoryWorkspaceId,
        scheduleProjectionReconcile: false,
        onProjectionReconcileNeeded: () => {
          projectionNeedsReconcile = true;
        },
      },
    );
    const candidate: SessionMessageCutCandidate = {
      kind: "session-message-cut",
      result,
      projectionNeedsReconcile,
      previousSessionIds: [...previous.values()].flatMap((entry) =>
        entry.sessionId ? [entry.sessionId] : [],
      ),
      publication:
        result.status === "created"
          ? prepareSessionEntryReplacementPublication(
              {
                previous,
                current: readSessionIdentitySnapshot(database, identityKeys),
                pendingArchiveRecovery: false,
                membershipInvalidatedKeys: [intent.targetKey],
                maintenancePlans: [],
              },
              database,
            )
          : undefined,
    };
    return candidate;
  };
  if (input.nativeBindings) {
    return runSessionNativeBindingTransaction(
      input.nativeBindings,
      context,
      "session.transcript.message-cut",
      "Session history navigation",
      (database, wrapReceipt) =>
        transferSessionEntryWorkerCandidate(database, context.admit, mutate(database), wrapReceipt),
    );
  }
  // No registered native owner needs retirement; the same typed A kernel still owns the cut.
  return withSqliteSessionDeletionWorkerParticipant(
    () => {},
    () =>
      context.writeTransaction(
        "session.transcript.message-cut",
        "Session history navigation",
        (database) =>
          transferSessionEntryWorkerCandidate(database, context.admit, mutate(database)),
      ),
  );
}
