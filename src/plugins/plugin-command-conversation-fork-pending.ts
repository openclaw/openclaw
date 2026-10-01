import { createHash } from "node:crypto";
import type { ConversationRef } from "../infra/outbound/session-binding-service.js";
import { createCorePluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";

type PendingChildPlacement = {
  version: 1;
  operationId: string;
  recordedAt: number;
};

const store = createCorePluginStateKeyedStore<PendingChildPlacement>({
  ownerId: "core:conversation-fork",
  namespace: "pending-child-placement",
  maxEntries: 10_000,
  overflowPolicy: "reject-new",
});

function key(conversation: ConversationRef): string {
  // Keep provider/group identifiers out of the shared-state plugin key index.
  return createHash("sha256")
    .update(
      JSON.stringify([conversation.channel, conversation.accountId, conversation.conversationId]),
    )
    .digest("hex");
}

export async function hasPendingChildPlacement(conversation: ConversationRef): Promise<boolean> {
  return (await store.lookup(key(conversation))) !== undefined;
}

export async function reserveChildPlacement(
  conversation: ConversationRef,
  operationId: string,
): Promise<boolean> {
  return await store.registerIfAbsent(key(conversation), {
    version: 1,
    operationId,
    recordedAt: Date.now(),
  });
}

export async function settleChildPlacement(
  conversation: ConversationRef,
  operationId: string,
): Promise<boolean> {
  const slot = key(conversation);
  const observed = await store.observe(slot);
  if (observed.value?.operationId !== operationId) {
    return false;
  }
  return (
    (
      await store.compareAndApply(slot, observed.comparison, {
        operation: "delete",
        action: "delete",
      })
    ).status === "applied"
  );
}
