import type { DatabaseSync } from "node:sqlite";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db-contract.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type { SqliteWorkerCommand } from "../sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../sqlite-worker-state-context.js";
import {
  readCurrentConversationBindingListInDatabase,
  pruneCurrentConversationBindingListInTransaction,
  readCurrentConversationBindingResolutionInDatabase,
  readCurrentConversationBindingSelectionInDatabase,
  updateCurrentConversationBindingRecordInDatabase,
} from "./current-conversation-bindings.kernel.js";
import type {
  CurrentConversationBindingWorkerOperations,
  CurrentConversationBindingTouch,
} from "./current-conversation-bindings.worker-contract.js";
import type { ConversationRef, SessionBindingRecord } from "./session-binding.types.js";

/** Worker-local reads cannot inherit the host's retained discovery snapshot. */
export function readSelection(
  conversations: readonly ConversationRef[],
  databasePath: string,
): ReadonlyArray<SessionBindingRecord | null> {
  return (
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => readCurrentConversationBindingSelectionInDatabase(db, conversations),
      { path: databasePath, env: getSqliteWorkerStateContext().environment },
    ) ?? conversations.map(() => null)
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

type CurrentConversationBindingWriteCommand = Exclude<
  SqliteWorkerCommand<CurrentConversationBindingWorkerOperations>,
  { type: "conversationBindings.readSelection" }
>;

export function isWriteCommand(command: {
  type: string;
}): command is CurrentConversationBindingWriteCommand {
  return (
    command.type === "conversationBindings.listBySession" ||
    command.type === "conversationBindings.resolve" ||
    command.type === "conversationBindings.touch"
  );
}

export function executeCommand(
  command: CurrentConversationBindingWriteCommand,
  options: OpenClawStateDatabaseOptions & { database: OpenClawStateDatabase },
): SessionBindingRecord | SessionBindingRecord[] | null {
  if (command.type === "conversationBindings.listBySession") {
    return listCurrentConversationBindingsInWorker(command.input, options);
  }
  if (command.type === "conversationBindings.resolve") {
    const result = readCurrentConversationBindingResolutionInDatabase(
      options.database.db,
      command.input,
    );
    if (!result.repair) {
      return result.record;
    }
  }
  return runOpenClawStateWriteTransaction(({ db }) => {
    requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
    const result =
      command.type === "conversationBindings.resolve"
        ? updateCurrentConversationBindingRecordInDatabase(db, command.input, (current) => current)
            .current
        : touchCurrentConversationBindingInDatabase(db, command.input);
    requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
    return result;
  }, options);
}

/** List and expiry repair stay at the same shared-state owner and physical worker context. */
function listCurrentConversationBindingsInWorker(
  input: CurrentConversationBindingWorkerOperations["conversationBindings.listBySession"]["input"],
  options: OpenClawStateDatabaseOptions & { database: OpenClawStateDatabase },
): SessionBindingRecord[] {
  const prepared = readCurrentConversationBindingListInDatabase(
    options.database.db,
    input.targetSessionKey,
    input.scope,
  );
  if (!prepared.requiresPrune) {
    return prepared.records;
  }
  return runOpenClawStateWriteTransaction(({ db }) => {
    requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
    const records = pruneCurrentConversationBindingListInTransaction(
      db,
      input.targetSessionKey,
      input.scope,
    );
    requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
    return records;
  }, options);
}
