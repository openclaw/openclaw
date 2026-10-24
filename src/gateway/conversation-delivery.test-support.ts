import path from "node:path";
import { onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as delivery from "../config/sessions/conversation-delivery-store.js";
import * as registry from "../config/sessions/conversation-registry.js";
import * as sqlite from "../config/sessions/session-accessor.sqlite-scope.js";
import { markDurableDeliveryQueued } from "../infra/outbound/delivery-completion.js";
import type { MessageActionInput } from "../infra/outbound/message-action-contracts.js";
import { buildConversationRef } from "../routing/conversation-ref.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";

const address = { channel: "reef", accountId: "default", kind: "direct" as const, peerId: "molty" };

export const conversation = {
  ...address,
  conversationRef: buildConversationRef(address),
  target: "reef:molty",
  sessionId: "reef-session",
  sessionKey: "agent:main:reef:direct:molty",
  role: "participant" as const,
  firstSeenAt: 100,
  lastSeenAt: 200,
};

export async function queueConversationDeliveryForTest(
  input: Pick<MessageActionInput, "deliveryCompletion" | "conversationDeliveryTarget">,
  queueId = "queue-1",
): Promise<void> {
  const { deliveryCompletion: completion, conversationDeliveryTarget: target } = input;
  if (!completion) {
    throw new Error("conversation delivery fixture requires a durable completion owner");
  }
  await markDurableDeliveryQueued(completion, queueId, undefined, undefined, undefined, target);
}

// Inspect committed state without joining the writer deliberately held by these tests.
export function readConversationDeliveryStateForTest(
  scope: delivery.ConversationDeliveryStoreScope,
  operationId: string,
) {
  const read = withOpenClawAgentDatabaseReadOnly(
    ({ db }) =>
      db
        .prepare(`
      SELECT status, queue_id AS queueId, platform_message_id AS platformMessageId,
        rejection_error AS rejectionError
      FROM conversation_deliveries WHERE operation_id = ?
    `)
        .get(operationId),
    sqlite.toDatabaseOptions(sqlite.resolveSqliteReadScope(scope)),
  );
  return read.found ? read.value : undefined;
}

export function holdConversationWriterForTest(scope: registry.PreparedConversationRegistryScope) {
  const entered = createDeferred();
  const released = createDeferred();
  const finished = runOpenClawAgentWriteAdmission(
    { agentId: scope.databaseAgentId, path: scope.storePath, env: scope.env },
    () => {
      entered.resolve();
      return released.promise;
    },
  );
  const release = async () => {
    released.resolve();
    await finished;
  };
  onTestFinished(release);
  return { entered: Promise.race([entered.promise, finished]), release };
}

export async function createConversationDeliveryTestStore(agentId = "main") {
  const dirs = useSessionStoreTempDirs(onTestFinished, "openclaw-gateway-conversation-");
  const agentDir = path.join(dirs.make(), "agents", agentId);
  const scope = { agentId, storePath: path.join(agentDir, "sessions", "sessions.json") };
  await registry.registerConversationAddresses(scope, [
    { ...conversation, deliveryTarget: conversation.target },
  ]);
  return {
    scope,
    config: { session: { store: scope.storePath } },
    beginOperation: vi.fn(delivery.beginConversationDeliveryOperation),
    getOperation: vi.fn(delivery.getConversationDeliveryOperation),
    markSent: vi.fn(delivery.markConversationDeliverySent),
    markSuppressed: vi.fn(delivery.markConversationDeliverySuppressed),
  };
}
