import type { DatabaseSync } from "node:sqlite";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type { SqliteWorkerCommand } from "../sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../sqlite-worker-operation-admission.js";
import {
  readCurrentConversationBindingResolutionInDatabase,
  updateCurrentConversationBindingRecordInDatabase,
} from "./current-conversation-bindings.kernel.js";
import type {
  CurrentConversationBindingWorkerOperations,
  CurrentConversationBindingTouch,
} from "./current-conversation-bindings.worker-contract.js";
import type { SessionBindingRecord } from "./session-binding.types.js";

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

export function executeCurrentConversationBindingCommand(
  command: SqliteWorkerCommand<CurrentConversationBindingWorkerOperations>,
  options: OpenClawStateDatabaseOptions & { database: OpenClawStateDatabase },
): SessionBindingRecord | null {
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
