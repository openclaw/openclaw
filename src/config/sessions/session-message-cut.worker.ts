import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { withSqliteSessionDeletionWorkerParticipant } from "./session-accessor.sqlite-deletion.js";
import { readSessionIdentitySnapshot } from "./session-accessor.sqlite-entry-store.js";
import { mutateSqliteSessionAtMessageInTransaction } from "./session-accessor.sqlite-message-cut.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import { transferSessionEntryWorkerCandidate } from "./session-entry-patch.worker.js";
import type {
  SessionMessageCutCandidate,
  SessionMessageCutCommit,
} from "./session-message-cut.types.js";
import { runSessionNativeBindingTransaction } from "./session-native-binding.worker.js";
import { collectSessionEntryLookupKeys } from "./store-entry.js";

export function commitSessionMessageCut(
  input: SessionMessageCutCommit,
  context: AgentWorkerOperationContext,
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
