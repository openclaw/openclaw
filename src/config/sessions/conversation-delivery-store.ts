import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import {
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentWriteAdmission,
} from "../../state/openclaw-agent-write-admission.js";
import {
  ConversationDeliveryInputError,
  ConversationDeliveryMissingError,
  type ConversationDeliveryRecord,
  type ConversationDeliveryInput,
  type ConversationDeliveryBegin,
  type ConversationDeliveryTransition,
  type ConversationDeliveryLookup,
} from "./conversation-delivery-store.types.js";
import {
  pinConversationDatabaseScope,
  type ConversationRegistryScope,
} from "./conversation-registry.js";
import { getSessionActorStorageBinding } from "./session-actor-storage-binding.js";
import { targetDiscoveryLane } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

export { ConversationDeliveryInputError, ConversationDeliveryMissingError };
export type { ConversationDeliveryRecord } from "./conversation-delivery-store.types.js";
export type ConversationDeliveryStoreScope = ConversationRegistryScope;

async function deliveryResult<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === "ConversationDeliveryInputError") {
        throw new ConversationDeliveryInputError(error.message);
      }
      if (error.name === "ConversationDeliveryMissingError") {
        throw new ConversationDeliveryMissingError(error.message);
      }
    }
    throw error;
  }
}

function readConversationDelivery(
  scope: ConversationDeliveryStoreScope,
  lookup: ConversationDeliveryLookup,
) {
  const memory = getSessionActorStorageBinding({
    agentId: scope.agentId,
    storePath: scope.storePath,
  });
  if (memory) {
    return deliveryResult(() =>
      memory.actor.storage!.read(
        { type: "session.conversation.delivery.read", input: lookup },
        memory.authority,
      ),
    );
  }
  const { options, scope: preparedScope } = pinConversationDatabaseScope(scope);
  const captured = structuredClone(lookup);
  // Reads share writer admission so they cannot overtake an accepted transition.
  return deliveryResult(() =>
    runOpenClawAgentWriteAdmission(options, () =>
      withSessionHistoryWorkerDatabase(
        options,
        (reader) => reader.readConversationDelivery({ lookup: captured, env: preparedScope.env }),
        // Conflict cleanup retains this FIFO turn and must not drain independent readers.
        targetDiscoveryLane,
      ),
    ),
  );
}

export async function getConversationDeliveryOperation(
  scope: ConversationDeliveryStoreScope,
  operationId: string,
  expectedInput?: ConversationDeliveryInput,
): Promise<ConversationDeliveryRecord | undefined> {
  return readConversationDelivery(scope, { operationId, expectedInput });
}

export async function findConversationTurnDeliveryByReplyTarget(
  scope: ConversationDeliveryStoreScope,
  params: { conversationRef: string; replyToId: string },
): Promise<ConversationDeliveryRecord | undefined> {
  return readConversationDelivery(scope, params);
}

function writeConversationDelivery(
  scope: ConversationDeliveryStoreScope,
  type: "conversation.delivery.begin",
  input: ConversationDeliveryBegin,
  assertCurrent?: () => void,
): Promise<{ created: boolean; record: ConversationDeliveryRecord }>;
function writeConversationDelivery(
  scope: ConversationDeliveryStoreScope,
  type: "conversation.delivery.transition",
  input: ConversationDeliveryTransition,
  assertCurrent?: () => void,
): Promise<ConversationDeliveryRecord>;
function writeConversationDelivery(
  scope: ConversationDeliveryStoreScope,
  ...[type, input, assertCurrent = () => {}]:
    | ["conversation.delivery.begin", ConversationDeliveryBegin, (() => void)?]
    | ["conversation.delivery.transition", ConversationDeliveryTransition, (() => void)?]
): Promise<ConversationDeliveryRecord | { created: boolean; record: ConversationDeliveryRecord }> {
  const memory = getSessionActorStorageBinding({
    agentId: scope.agentId,
    storePath: scope.storePath,
  });
  if (memory) {
    return deliveryResult(async () => {
      const authority = {
        assertCurrent: () => memory.authority.assertCurrent(),
        authorize: (...args: Parameters<typeof memory.authority.authorize>) => {
          assertCurrent();
          memory.authority.authorize(...args);
        },
      };
      const outcome =
        type === "conversation.delivery.begin"
          ? await memory.actor.storage!.mutate(
              { type: "session.conversation.delivery.begin", input },
              authority,
            )
          : await memory.actor.storage!.mutate(
              { type: "session.conversation.delivery.transition", input },
              authority,
            );
      if (outcome.kind === "rolled-back") {
        const error = new Error(outcome.error.message);
        error.name = outcome.error.name;
        throw error;
      }
      return outcome.value;
    });
  }
  const { options } = pinConversationDatabaseScope(scope);
  const execution = captureOpenClawAgentDatabaseExecution(options);
  const captured = structuredClone(input);
  return deliveryResult(async () => {
    try {
      const result = await runOpenClawAgentWorkerWrite(options, () =>
        execution.runExisting(
          {
            assertCurrent,
            createAdmission(binding) {
              return () => ({
                nativeLocations: binding.nativeLocations,
                admission: createSqliteWorkerOperationAdmission((request, grant) => {
                  binding.authorize(request);
                  assertCurrent();
                  if (!grant()) {
                    throw new Error("Conversation delivery authority expired");
                  }
                }, binding.attachment),
              });
            },
          },
          (worker) => worker.execute({ type, input: captured }),
        ),
      );
      if (!result) {
        throw new ConversationDeliveryMissingError("Conversation delivery database is missing");
      }
      return result;
    } finally {
      await execution.release();
    }
  });
}

export async function beginConversationDeliveryOperation(
  scope: ConversationDeliveryStoreScope,
  params: ConversationDeliveryBegin,
  assertCurrent?: () => void,
): Promise<{ created: boolean; record: ConversationDeliveryRecord }> {
  return writeConversationDelivery(scope, "conversation.delivery.begin", params, assertCurrent);
}

export async function markConversationDeliveryQueued(
  scope: ConversationDeliveryStoreScope,
  operationId: string,
  queueId: string,
): Promise<ConversationDeliveryRecord> {
  return writeConversationDelivery(scope, "conversation.delivery.transition", {
    operationId,
    status: "queued",
    queueId,
    allowedFrom: ["created"],
  });
}

export async function markConversationDeliverySent(
  scope: ConversationDeliveryStoreScope,
  operationId: string,
  platformMessageId?: string,
): Promise<ConversationDeliveryRecord> {
  return writeConversationDelivery(scope, "conversation.delivery.transition", {
    operationId,
    status: "sent",
    ...(platformMessageId ? { platformMessageId } : {}),
    allowedFrom: ["created", "queued"],
  });
}

export async function markConversationDeliverySuppressed(
  scope: ConversationDeliveryStoreScope,
  operationId: string,
): Promise<ConversationDeliveryRecord> {
  return writeConversationDelivery(scope, "conversation.delivery.transition", {
    operationId,
    status: "suppressed",
    allowedFrom: ["created", "queued"],
  });
}

export async function markConversationDeliveryRejected(
  scope: ConversationDeliveryStoreScope,
  operationId: string,
  rejectionError: string,
): Promise<ConversationDeliveryRecord> {
  const normalizedError = rejectionError.trim();
  if (!normalizedError) {
    throw new Error("Conversation delivery rejection error is required");
  }
  return writeConversationDelivery(scope, "conversation.delivery.transition", {
    operationId,
    status: "rejected",
    rejectionError: normalizedError,
    allowedFrom: ["created", "queued"],
  });
}

export async function markConversationDeliveryUnknown(
  scope: ConversationDeliveryStoreScope,
  operationId: string,
): Promise<ConversationDeliveryRecord> {
  return writeConversationDelivery(scope, "conversation.delivery.transition", {
    operationId,
    status: "unknown",
    allowedFrom: ["created", "queued"],
  });
}

export async function markConversationDeliveryReplied(
  scope: ConversationDeliveryStoreScope,
  params: {
    operationId: string;
    reply: NonNullable<ConversationDeliveryRecord["reply"]>;
    session?: ConversationDeliveryTransition["session"];
  },
  assertCurrent?: () => void,
): Promise<ConversationDeliveryRecord> {
  return writeConversationDelivery(
    scope,
    "conversation.delivery.transition",
    {
      operationId: params.operationId,
      status: "replied",
      reply: params.reply,
      allowedFrom: ["queued", "sent"],
      session: params.session,
    },
    assertCurrent,
  );
}
