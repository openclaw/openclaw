import type { DatabaseSync } from "node:sqlite";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type {
  WorkerOperationHandlers,
  WorkerOperations,
} from "../../state/worker-operation-registry.js";
import { requestSqliteWorkerOperationAdmission } from "../sqlite-worker-operation-admission.js";
import {
  readCurrentConversationBindingListInDatabase,
  pruneCurrentConversationBindingListInTransaction,
  readCurrentConversationBindingResolutionInDatabase,
  readCurrentConversationBindingSelectionInDatabase,
  updateCurrentConversationBindingRecordInDatabase,
} from "./current-conversation-bindings.kernel.js";
import type { CurrentConversationBindingTouch } from "./current-conversation-bindings.worker-contract.js";
import type { ConversationRef, SessionBindingRecord } from "./session-binding.types.js";

/** The caller holds the shared-state write transaction and current host admission. */
function touchCurrentConversationBindingInDatabase(
  db: DatabaseSync,
  input: CurrentConversationBindingTouch,
): SessionBindingRecord | null {
  const conversation = input.conversation;
  return updateCurrentConversationBindingRecordInDatabase(db, conversation, (current) => {
    if (current?.bindingId !== input.bindingId) {
      return current;
    }
    if (!input.accountPolicy) {
      return { ...current, metadata: { ...current.metadata, lastActivityAt: input.at } };
    }
    const { idleTimeoutMs, maxAgeMs } = input.accountPolicy;
    const idleExpiresAt = idleTimeoutMs > 0 ? input.at + idleTimeoutMs : undefined;
    const maxAgeExpiresAt = maxAgeMs > 0 ? current.boundAt + maxAgeMs : undefined;
    return {
      bindingId: `${conversation.accountId}:${conversation.conversationId}`,
      targetSessionKey: current.targetSessionKey,
      targetKind: input.accountPolicy.targetKinds[current.targetKind],
      conversation,
      status: "active",
      boundAt: current.boundAt,
      expiresAt:
        idleExpiresAt != null && maxAgeExpiresAt != null
          ? Math.min(idleExpiresAt, maxAgeExpiresAt)
          : (idleExpiresAt ?? maxAgeExpiresAt),
      metadata: {
        ...current.metadata,
        agentId:
          typeof current.metadata?.agentId === "string" ? current.metadata.agentId : undefined,
        label: typeof current.metadata?.label === "string" ? current.metadata.label : undefined,
        boundBy:
          typeof current.metadata?.boundBy === "string" ? current.metadata.boundBy : undefined,
        lastActivityAt: input.at,
        idleTimeoutMs,
        maxAgeMs,
      },
    };
  }).current;
}

export const conversationBindingOperations = {
  "conversationBindings.readSelection": (
    input: readonly ConversationRef[],
    { stateOptions },
  ): ReadonlyArray<SessionBindingRecord | null> =>
    // Worker-local reads cannot inherit the host's retained discovery snapshot.
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => readCurrentConversationBindingSelectionInDatabase(db, input),
      stateOptions(),
    ) ?? input.map(() => null),
  "conversationBindings.listBySession": (
    input: { targetSessionKey: string; scope?: { channel: string; accountId: string } },
    { open, stateOptions },
  ) => {
    const database = open();
    const prepared = readCurrentConversationBindingListInDatabase(
      database.db,
      input.targetSessionKey,
      input.scope,
    );
    if (!prepared.requiresPrune) {
      return prepared.records;
    }
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        const records = pruneCurrentConversationBindingListInTransaction(
          db,
          input.targetSessionKey,
          input.scope,
        );
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        return records;
      },
      { database, ...stateOptions() },
    );
  },
  "conversationBindings.resolve": (input: ConversationRef, { open, stateOptions }) => {
    const database = open();
    const result = readCurrentConversationBindingResolutionInDatabase(database.db, input);
    if (!result.repair) {
      return result.record;
    }
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        const record = updateCurrentConversationBindingRecordInDatabase(
          db,
          input,
          (current) => current,
        ).current;
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        return record;
      },
      { database, ...stateOptions() },
    );
  },
  "conversationBindings.touch": (input: CurrentConversationBindingTouch, { open, stateOptions }) =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        const record = touchCurrentConversationBindingInDatabase(db, input);
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        return record;
      },
      { database: open(), ...stateOptions() },
    ),
} satisfies WorkerOperationHandlers;

export type CurrentConversationBindingWorkerOperations = WorkerOperations<
  typeof conversationBindingOperations
>;
