import path from "node:path";
import { beginConversationDeliveryOperation } from "../../config/sessions/conversation-delivery-store.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { buildConversationRef } from "../../routing/conversation-ref.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { enqueueDeliveryOnce } from "./delivery-queue-storage.js";

export async function createConversationRecoveryFixture({
  operationId,
  stateDir,
  delivery = {},
}: {
  operationId: string;
  stateDir: string;
  delivery?: Partial<Parameters<typeof enqueueDeliveryOnce>[0]>;
}) {
  const storePath = path.join(stateDir, "agent-sessions.json");
  const scope = {
    agentId: "main",
    storePath,
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  };
  const conversationRef = buildConversationRef({
    channel: "reef",
    accountId: "default",
    kind: "direct",
    peerId: "peer-agent",
  });
  await upsertSessionEntryCore(
    { ...scope, sessionKey: "agent:main:reef:direct:peer-agent" },
    {
      sessionId: "reef-session",
      updatedAt: 100,
      chatType: "direct",
      delivery: normalizeSessionDeliveryState({
        context: { channel: "reef", accountId: "default", to: "reef:peer-agent" },
        origin: {
          provider: "reef",
          accountId: "default",
          nativeDirectUserId: "peer-agent",
        },
      }),
    },
  );
  await beginConversationDeliveryOperation(scope, {
    operationId,
    operationKind: "send",
    conversationRef,
    message: "hello",
    preparedMessageId: "reef-prepared",
  });
  await enqueueDeliveryOnce(
    {
      channel: "reef",
      to: "reef:peer-agent",
      queuePolicy: "required",
      payloads: [{ text: "hello" }],
      ...delivery,
      deliveryCompletion: {
        kind: "conversation",
        agentId: "main",
        operationId,
        storePath,
        routeFingerprint: "route-recovery",
      },
    },
    operationId,
    stateDir,
  );
  return scope;
}
