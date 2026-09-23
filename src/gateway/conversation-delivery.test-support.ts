import path from "node:path";
import { onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  beginConversationDeliveryOperation,
  getConversationDeliveryOperation,
  markConversationDeliverySent,
  markConversationDeliverySuppressed,
} from "../config/sessions/conversation-delivery-store.js";
import {
  registerConversationAddresses,
  type PreparedConversationRegistryScope,
} from "../config/sessions/conversation-registry.js";
import { markDurableDeliveryQueued } from "../infra/outbound/delivery-completion.js";
import type { MessageActionInput } from "../infra/outbound/message-action-contracts.js";
import { buildConversationRef } from "../routing/conversation-ref.js";
import { closeOpenClawAgentDatabaseByPath } from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";

const address = {
  channel: "reef",
  accountId: "default",
  kind: "direct" as const,
  peerId: "molty",
};

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
  if (!input.deliveryCompletion) {
    throw new Error("conversation delivery fixture requires a durable completion owner");
  }
  await markDurableDeliveryQueued(
    input.deliveryCompletion,
    queueId,
    undefined,
    undefined,
    undefined,
    input.conversationDeliveryTarget,
  );
}

export function holdConversationWriterForTest(scope: PreparedConversationRegistryScope) {
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

export function createConversationDeliveryTestStore(agentId = "main") {
  const dirs = createTempDirTracker();
  const agentDir = path.join(dirs.make("openclaw-gateway-conversation-"), "agents", agentId);
  const scope = { agentId, storePath: path.join(agentDir, "sessions", "sessions.json") };
  onTestFinished(() => {
    closeOpenClawAgentDatabaseByPath(path.join(agentDir, "agent", "openclaw-agent.sqlite"));
    dirs.cleanup();
  });
  registerConversationAddresses(scope, [{ ...conversation, deliveryTarget: conversation.target }]);
  return {
    scope,
    config: { session: { store: scope.storePath } },
    beginOperation: vi.fn(beginConversationDeliveryOperation),
    getOperation: vi.fn(getConversationDeliveryOperation),
    markSent: vi.fn(markConversationDeliverySent),
    markSuppressed: vi.fn(markConversationDeliverySuppressed),
  };
}
