import type { DatabaseSync } from "node:sqlite";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type {
  WorkerOperationContext,
  WorkerOperationHandlers,
  WorkerOperations,
  WorkerWriteOperationContext,
} from "../../state/worker-operation-registry.js";
import { requestSqliteWorkerOperationAdmission } from "../sqlite-worker-operation-admission.js";
import {
  bindCurrentConversationInDatabase,
  removeCurrentConversationBindingsInDatabase,
  readCurrentConversationBindingListInDatabase,
  pruneCurrentConversationBindingListInTransaction,
  readCurrentConversationBindingResolutionInDatabase,
  readCurrentConversationBindingSelectionInDatabase,
  updateCurrentConversationBindingRecordInDatabase,
} from "./current-conversation-bindings.kernel.js";
import type {
  CurrentConversationBindingBind,
  CurrentConversationBindingRemove,
  CurrentConversationBindingTouch,
} from "./current-conversation-bindings.worker-contract.js";
import type { ConversationRef, SessionBindingRecord } from "./session-binding.types.js";

function runBindingTransaction<T>(
  context: WorkerOperationContext,
  update: (db: DatabaseSync) => T,
  database = context.open(),
): T {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const result = update(db);
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return result;
    },
    { database, ...context.stateOptions() },
  );
}

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
  "conversationBindings.bind": (input: CurrentConversationBindingBind, { write }) => {
    return write(({ db }) => {
      const record = bindCurrentConversationInDatabase(db, input, (requiresAgentId) =>
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: requiresAgentId }),
      );
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return record;
    });
  },
  "conversationBindings.remove": (input: CurrentConversationBindingRemove, { write }) => {
    return write(({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const records = removeCurrentConversationBindingsInDatabase(db, input);
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return records;
    });
  },
  "conversationBindings.readSelection": (
    input: readonly ConversationRef[],
    { stateOptions },
  ): ReadonlyArray<SessionBindingRecord | null> =>
    // Worker-local reads cannot inherit the host's retained discovery snapshot.
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => readCurrentConversationBindingSelectionInDatabase(db, input),
      stateOptions(),
    ) ?? input.map(() => null),
  "conversationBindings.listBySessions": (
    input: { targetSessionKeys: readonly string[]; scope?: { channel: string; accountId: string } },
    context,
  ) => {
    const database = context.open();
    const prepared = input.targetSessionKeys.map((key) =>
      readCurrentConversationBindingListInDatabase(database.db, key, input.scope),
    );
    if (!prepared.some((list) => list.requiresPrune)) {
      return prepared.map((list) => list.records);
    }
    return runBindingTransaction(
      context,
      (db) =>
        prepared.map((list, index) => {
          const key = input.targetSessionKeys[index]!;
          const current = list.requiresPrune
            ? list
            : readCurrentConversationBindingListInDatabase(db, key, input.scope);
          return current.requiresPrune
            ? pruneCurrentConversationBindingListInTransaction(db, key, input.scope)
            : current.records;
        }),
      database,
    );
  },
  "conversationBindings.resolve": (input: ConversationRef, context) => {
    const database = context.open();
    const result = readCurrentConversationBindingResolutionInDatabase(database.db, input);
    if (!result.repair) {
      return result.record;
    }
    return runBindingTransaction(
      context,
      (db) =>
        updateCurrentConversationBindingRecordInDatabase(db, input, (current) => current).current,
      database,
    );
  },
  "conversationBindings.touch": (input: CurrentConversationBindingTouch, context) =>
    runBindingTransaction(context, (db) => touchCurrentConversationBindingInDatabase(db, input)),
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;

export type CurrentConversationBindingWorkerOperations = WorkerOperations<
  typeof conversationBindingOperations
>;
